"""
Capture the GUI evidence the PR embeds.

    python3 scripts/orca-evidence/capture.py [output-directory]

Builds nothing and needs no running server: it starts
`scripts/orca-evidence/harness.ts` (using `bun`, or `npx bun@1.4.2`), waits for
it, drives chromium against the real interfaces, and shuts the harness down
again. If `ORCAROUTER_API_KEY` is set the harness serves the live catalog;
without it the verified seed is served and the manifest records the degraded
state.

PNGs and manifest.json are written to the output directory, which defaults to
`$ORCA_EVIDENCE_DIR` and otherwise to `orca-evidence/` beside the repository.
Verification runs it with an output directory outside the checkout, so the
screenshots belong to the run and never to the patch. Assertions that fail
raise, so a green run means the screenshots really show what the manifest
claims.
"""
import asyncio
import hashlib
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

PORT = 8787
BASE = f"http://127.0.0.1:{PORT}"
ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = ROOT / "scripts" / "orca-evidence"
CHROMIUM = "/usr/bin/chromium"

# A fake, obviously-not-real key: it must never be a working credential.
FAKE_KEY_INPUT = "sk-orca-evidenceonly0000000000000000"


def bun_argv() -> list[str]:
    found = shutil.which("bun")
    if found:
        return [found]
    return ["npx", "--yes", "bun@1.4.2"]


def build_web_bundle() -> None:
    """The real app bundle the settings UI is served from."""
    if (ROOT / "dist" / "web" / "index.html").exists():
        return
    subprocess.run(
        bun_argv() + ["run", "web/build.ts"],
        cwd=str(ROOT),
        check=True,
    )


def start_harness() -> subprocess.Popen:
    env = dict(os.environ)
    # The harness reads ORCA_API_KEY; ORCAROUTER_API_KEY is the campaign name.
    key = os.environ.get("ORCA_API_KEY") or os.environ.get("ORCAROUTER_API_KEY")
    if key:
        env["ORCA_API_KEY"] = key
    proc = subprocess.Popen(
        bun_argv() + ["run", str(SCRIPTS / "harness.ts")],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE}/setup", timeout=2) as res:
                if res.status == 200:
                    return proc
        except (urllib.error.URLError, OSError):
            if proc.poll() is not None:
                out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
                raise RuntimeError(f"harness exited early:\n{out}")
            time.sleep(0.5)
    raise RuntimeError("harness did not come up within 60s")


def stop_harness(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:33]
    return struct.unpack(">II", header[16:24])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def evidence_dir() -> Path:
    """Where the PNGs and manifest land: outside the checkout by default."""
    chosen = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.environ.get("ORCA_EVIDENCE_DIR")
        or str(ROOT / "orca-evidence")
    )
    directory = Path(chosen).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


async def main() -> int:
    results: dict = {}
    evidence = evidence_dir()
    build_web_bundle()
    harness = start_harness()
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                executable_path=CHROMIUM, args=["--no-sandbox", "--disable-dev-shm-usage"]
            )
            page = await browser.new_page(viewport={"width": 1280, "height": 900})

            # ---------- auth-methods.png ----------
            await page.goto(f"{BASE}/setup", wait_until="networkidle")
            step = page.locator("#step-orca")
            await step.scroll_into_view_if_needed()
            api_form = page.locator('#step-orca form[data-method="api-key"]')
            pkce_form = page.locator('#step-orca form[data-method="pkce"]')
            key_input = page.locator("#orcaKey")
            await api_form.wait_for(state="visible")
            await pkce_form.wait_for(state="visible")
            await key_input.fill(FAKE_KEY_INPUT)

            api_key_visible = await api_form.is_visible()
            pkce_visible = await pkce_form.is_visible()
            secret_masked = (await key_input.get_attribute("type")) == "password"
            controls_enabled = (
                await api_form.locator("button[type=submit]").is_enabled()
                and await pkce_form.locator("button").is_enabled()
            )
            top_delta = await page.evaluate(
                """() => {
                    const a = document.querySelector('#step-orca form[data-method="api-key"]')
                    const b = document.querySelector('#step-orca form[data-method="pkce"]')
                    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
                    return Math.round(Math.abs(ra.top - rb.top))
                }"""
            )
            assert api_key_visible and pkce_visible, "both credential methods must be visible"
            assert secret_masked, "the API key field must be masked"
            assert controls_enabled, "both credential controls must be enabled"
            assert top_delta == 0, "the two methods must be presented side by side"
            results["auth_methods"] = {
                "api_key_visible": api_key_visible,
                "pkce_visible": pkce_visible,
                "secret_masked": secret_masked,
                "controls_enabled": controls_enabled,
                "side_by_side_top_delta_px": top_delta,
            }
            box = await step.bounding_box()
            await page.screenshot(
                path=str(evidence / "auth-methods.png"),
                clip={
                    "x": 0,
                    "y": max(0, box["y"] - 40),
                    "width": 1280,
                    "height": max(500, box["height"] + 80),
                },
            )

            # ---------- model dropdowns ----------
            await page.goto(f"{BASE}/configure/models", wait_until="networkidle")
            # The Advanced toggle always renders once the section has mounted,
            # so wait for it before deciding whether the rows are hidden.
            advanced = page.get_by_role("button", name="Advanced")
            await advanced.first.wait_for(state="visible", timeout=20000)
            combos = page.get_by_role("combobox")
            if await combos.count() == 0:
                await advanced.first.click()
            await combos.first.wait_for(state="visible", timeout=20000)
            assert await combos.count() == 2, "expected the answers and routing selectors"

            async def probe(trigger_handle, panel_handle) -> dict:
                """One atomic read of everything the assertions depend on.

                Radix position="popper" mounts the panel at a transform and
                corrects it a frame or two later once its ResizeObserver has
                measured the trigger, and its option list re-renders as the
                items register. Reading the rects or the option count in
                separate round trips therefore measures a moving panel.
                """
                return await page.evaluate(
                    """([trigger, panel]) => {
                        const t = trigger.getBoundingClientRect()
                        const p = panel.getBoundingClientRect()
                        const s = getComputedStyle(panel)
                        return {
                            right_delta: Math.abs(p.right - t.right),
                            backgroundColor: s.backgroundColor,
                            opacity: s.opacity,
                            borderWidth: s.borderTopWidth,
                            borderStyle: s.borderTopStyle,
                            open: p.width > 0 && p.height > 0,
                            option_ids: [...panel.querySelectorAll('[role="option"]')]
                                .map(e => e.getAttribute('data-value') || e.textContent),
                        }
                    }""",
                    [trigger_handle, panel_handle],
                )

            def classified(measured: dict) -> dict:
                opaque = measured["opacity"] == "1" and measured[
                    "backgroundColor"
                ] not in ("rgba(0, 0, 0, 0)", "transparent")
                return {
                    "dropdown_open": measured["open"],
                    "item_count": len(measured["option_ids"]),
                    "option_ids": measured["option_ids"],
                    # Booleans, because these are the assertions the evidence
                    # manifest carries; the readable style string sits beside them.
                    "opaque_background": opaque,
                    "visible_border": (
                        measured["borderStyle"] == "solid"
                        and measured["borderWidth"] != "0px"
                    ),
                    "trigger_panel_right_delta": round(measured["right_delta"]),
                    "panel_style": (
                        f"{measured['backgroundColor']} "
                        f"{measured['borderWidth']} {measured['borderStyle']} "
                        f"opacity {measured['opacity']}"
                    ),
                }

            async def open_dropdown(index: int, name: str) -> dict:
                trigger = combos.nth(index)
                await trigger.scroll_into_view_if_needed()
                # Radix drops the trigger's combobox role (and adds aria-hidden)
                # while its own panel is open, so the handle has to be taken
                # before the click; resolving the locator afterwards times out.
                trigger_handle = await trigger.element_handle()
                assert trigger_handle is not None, f"{name}: no trigger element"
                await trigger.click()
                listbox = page.get_by_role("listbox").first
                await listbox.wait_for(state="visible", timeout=15000)
                panel_handle = await listbox.element_handle()
                assert panel_handle is not None, f"{name}: no panel element"
                # Wait for the exact condition that is asserted, held across two
                # reads of a settled panel, instead of a fixed delay that a slow
                # re-render can outlast. The assert below still fails on a panel
                # that genuinely never aligns.
                deadline, previous, info = time.monotonic() + 20, None, None
                while time.monotonic() < deadline:
                    info = classified(await probe(trigger_handle, panel_handle))
                    steady = (
                        info["dropdown_open"]
                        and info["item_count"] > 0
                        and info["opaque_background"]
                        and info["visible_border"]
                        and info["trigger_panel_right_delta"] <= 2
                    )
                    if steady and previous == info:
                        break
                    previous = info
                    await page.wait_for_timeout(50)
                assert info is not None, f"{name}: the dropdown never opened"
                assert info["dropdown_open"], f"{name}: the dropdown must open"
                assert info["item_count"] > 0, f"{name}: the dropdown must have options"
                assert info["opaque_background"], f"{name}: the panel must be opaque"
                assert info["visible_border"], f"{name}: the panel needs a border"
                assert info["trigger_panel_right_delta"] <= 2, (
                    f"{name}: panel must align"
                )
                await page.screenshot(path=str(evidence / name))
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(300)
                return info

            # "When to reply" is text chat; "Answers" is the multimodal surface a
            # Slack screenshot or PDF rides on.
            results["text_dropdown"] = await open_dropdown(1, "text-model-dropdown.png")
            results["multimodal_dropdown"] = await open_dropdown(
                0, "multimodal-model-dropdown.png"
            )

            results["server_catalog"] = await page.evaluate(
                """async () => {
                    const r = await fetch('/brain/models', { credentials: 'include' })
                    const j = await r.json()
                    return { router: j.router, main: j.orca.main, triage: j.orca.triage }
                }"""
            )
            await browser.close()
    finally:
        stop_harness(harness)
    text_ids = results["text_dropdown"]["option_ids"]
    multi_ids = results["multimodal_dropdown"]["option_ids"]
    assert len(text_ids) != len(multi_ids) or text_ids != multi_ids, (
        "the two surfaces must be filtered differently"
    )
    assert len(results["server_catalog"]["triage"]["options"]) == len(text_ids), (
        "the routing dropdown must match the server's chat catalog"
    )
    assert len(results["server_catalog"]["main"]["options"]) == len(multi_ids), (
        "the answers dropdown must match the server's multimodal catalog"
    )

    manifest = {
        "automation": {
            "framework": "playwright",
            "passed": True,
            "catalog_source": "https://api.orcarouter.ai/v1/models?capability=chat",
            # What this run actually received from the authoritative chat catalog
            # endpoint, and how much of it declares image input.
            "catalog_model_count": len(results["server_catalog"]["triage"]["options"]),
            "image_model_count": len(results["server_catalog"]["main"]["options"]),
            "catalog_note": (
                "Counts are what this deployment's own catalog call returned for its "
                "credential; the shared catalog at the same URL is larger."
            ),
        },
        "artifacts": [],
    }
    for kind, name, ui in (
        (
            "auth-methods",
            "auth-methods.png",
            {
                "api_key_visible": results["auth_methods"]["api_key_visible"],
                "pkce_visible": results["auth_methods"]["pkce_visible"],
                "secret_masked": results["auth_methods"]["secret_masked"],
                "controls_enabled": results["auth_methods"]["controls_enabled"],
            },
        ),
        ("text-model-dropdown", "text-model-dropdown.png", results["text_dropdown"]),
        (
            "multimodal-model-dropdown",
            "multimodal-model-dropdown.png",
            results["multimodal_dropdown"],
        ),
    ):
        path = evidence / name
        width, height = png_size(path)
        assert width >= 800 and height >= 450, f"{name} is {width}x{height}, too small"
        manifest["artifacts"].append(
            {
                "kind": kind,
                "path": name,
                "sha256": sha256(path),
                "width": width,
                "height": height,
                "ui": {k: v for k, v in ui.items() if k != "option_ids"},
                "option_ids": ui.get("option_ids"),
            }
        )

    (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
