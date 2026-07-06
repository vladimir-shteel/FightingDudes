#!/usr/bin/env python3
"""Bundles the Fighting Dudes prototype into a single self-contained HTML file."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "fighting-dudes.html"

# Concatenation order — respects dependency graph (utils -> config -> factories -> state -> physics -> systems -> ui -> main).
JS_ORDER = [
    "js/game/utils.js",
    "js/game/config.js",
    "js/game/factories.js",
    "js/game/state.js",
    "js/game/physics/battlePhysics.js",
    "js/game/systems/mineSystem.js",
    "js/game/systems/reserveSystem.js",
    "js/game/systems/battleSystem.js",
    "js/game/systems/garrisonSystem.js",
    "js/game/ui.js",
    "js/main.js",
]

DATA_FILES = {
    "balance": "data/balance.json",
    "equipment": "data/equipment.json",
    "waves": "data/waves.json",
    "unitLevels": "data/unit-levels.json",
    "mineLevels": "data/mine-levels.json",
}


EXTERNAL_IMPORTS: list[str] = []


def extract_external_imports(source: str) -> str:
    def collect(match: re.Match) -> str:
        EXTERNAL_IMPORTS.append(match.group(0).rstrip())
        return ''
    # Capture `import ... from "https://..."` (single line) and remove from module body.
    return re.sub(
        r'^import\s+[^;\n]+from\s+["\']https?://[^"\']+["\'];?\s*\n',
        collect,
        source,
        flags=re.MULTILINE,
    )


def strip_local_imports(source: str) -> str:
    # Drop `import ... from "./..."` / `import ... from "../..."` including multi-line { ... } forms.
    return re.sub(
        r'^import\s+(?:[\w*\s{},]+\s+from\s+)?["\']\.{1,2}/[^"\']+["\'];?\s*\n',
        '',
        source,
        flags=re.MULTILINE | re.DOTALL,
    )


EXPORT_DECL_RE = re.compile(
    r'^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)',
    re.MULTILINE,
)


def strip_exports(source: str) -> tuple[str, list[str]]:
    names = EXPORT_DECL_RE.findall(source)
    cleaned = re.sub(
        r'^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)',
        '',
        source,
        flags=re.MULTILINE,
    )
    return cleaned, names


def load_js(relative_path: str) -> tuple[str, list[str]]:
    text = (ROOT / relative_path).read_text(encoding="utf-8")
    text = extract_external_imports(text)
    text = strip_local_imports(text)
    text, exports = strip_exports(text)
    return text, exports


def load_data() -> dict:
    payload = {}
    for key, path in DATA_FILES.items():
        payload[key] = json.loads((ROOT / path).read_text(encoding="utf-8"))
    return payload


def build_js_bundle(data: dict) -> str:
    body_parts: list[str] = []
    body_parts.append("const __EMBEDDED_DATA__ = " + json.dumps(data, ensure_ascii=False) + ";")

    for rel in JS_ORDER:
        source, exports = load_js(rel)
        # Patch config.js: replace the async fetch-based initConfig with a synchronous embedded version.
        if rel.endswith("config.js"):
            source = re.sub(
                r'async function initConfig\(\)[\s\S]*?^\}\n',
                (
                    "async function initConfig() {\n"
                    "  const { balance, equipment, waves, unitLevels, mineLevels } = __EMBEDDED_DATA__;\n"
                    "  Object.assign(CONFIG, balance, {\n"
                    "    equipment,\n"
                    "    waves,\n"
                    "    unitLevels: unitLevels.levels,\n"
                    "    mine: mineLevels\n"
                    "  });\n"
                    "}\n"
                ),
                source,
                flags=re.MULTILINE,
            )
            # Remove the now-unused fetch helpers.
            source = re.sub(r'function getBasePath\(\)[\s\S]*?^\}\n', '', source, flags=re.MULTILINE)
            source = re.sub(r'async function fetchJson\([\s\S]*?^\}\n', '', source, flags=re.MULTILINE)

        # Wrap each file body in an IIFE and expose only its exported names to the global scope.
        # This isolates module-private helpers (avoiding collisions like `clamp`, `getAttackRange`,
        # `getCombinedCosts`) while letting other files reach exports via bare identifiers.
        export_line = ""
        if exports:
            export_line = "Object.assign(globalThis, { " + ", ".join(exports) + " });"
        wrapped = "// ===== " + rel + " =====\n(() => {\n" + source + "\n" + export_line + "\n})();"
        body_parts.append(wrapped)

    header = ["// Auto-generated bundle. Do not edit by hand."]
    header.extend(EXTERNAL_IMPORTS)
    return "\n".join(header) + "\n\n" + "\n\n".join(body_parts)


def main() -> None:
    data = load_data()
    js_bundle = build_js_bundle(data)
    css = (ROOT / "styles.css").read_text(encoding="utf-8")
    html = (ROOT / "index.html").read_text(encoding="utf-8")

    # Strip the external CSS <link> and swap in inline <style>.
    html = re.sub(r'\s*<link rel="stylesheet" href="\./styles\.css">\s*', '\n  <style>\n' + css + '\n  </style>\n', html)
    # Swap the external module script for the inline bundle. Keep type="module" so the planck CDN import works.
    html = re.sub(
        r'<script type="module" src="\./js/main\.js"></script>',
        '<script type="module">\n' + js_bundle + '\n</script>',
        html,
    )

    OUT.write_text(html, encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
