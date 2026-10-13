"""Create distributable archives without machine configuration or user records."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
import zipfile
from pathlib import Path


def write_zip(destination: Path, entries: list[tuple[str, Path | bytes]]) -> dict:
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".zip", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, content in sorted(entries, key=lambda item: item[0]):
                if isinstance(content, bytes):
                    archive.writestr(name, content)
                else:
                    archive.write(content, name)
        temporary_path.replace(destination)
    finally:
        temporary_path.unlink(missing_ok=True)
    return {"file": destination.name, "bytes": destination.stat().st_size,
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "files": len(entries)}


def workbuddy_manifest(text: str) -> bytes:
    # Keep the common manifest strict; promote WorkBuddy-specific metadata only in its archive.
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not match:
        raise ValueError("SKILL.md has no YAML frontmatter")
    frontmatter = match.group(1)
    promoted = []
    for key in ("description_zh", "description_en", "version", "author"):
        value = re.search(r"^  " + key + r": (.+)$", frontmatter, re.M)
        if not value:
            raise ValueError(f"Missing WorkBuddy metadata: {key}")
        promoted.append(f"{key}: {value.group(1)}")
    return ("---\n" + frontmatter + "\n" + "\n".join(promoted) + "\n---\n" + text[match.end():]).encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    project = args.project.resolve()
    skill = project / "portable" / "organic-lab-records"
    output = (args.output or project / "dist").resolve()
    output.mkdir(parents=True, exist_ok=True)
    required = ("SKILL.md", "setup.ps1", "setup-codex.cmd", "setup-opencode.cmd",
                "manifest.yaml", "core/workflow.md", "core/chemistry.md", "references/recovery.md",
                "scripts/replay_examples.py", "assets/examples/linear.json", "assets/examples/branched-stereo.json",
                "scripts/organic-lab.cjs", "scripts/chemistry_worker.py", "references/tools.json",
                "scripts/runtime/node.exe", "scripts/runtime/NODE-LICENSE.txt", "bundle.json",
                "assets/opencode-command/lab.md",
                "assets/obsidian-plugin/main.js", "assets/obsidian-plugin/manifest.json",
                "assets/obsidian-plugin/styles.css", "assets/obsidian-plugin/chemistry_worker.py")
    for relative in required:
        if not (skill / relative).is_file():
            raise FileNotFoundError(f"Build the Windows skill first; missing {relative}")
    windows, buddy = [], []
    for file in sorted(skill.rglob("*")):
        if not file.is_file():
            continue
        relative = file.relative_to(skill)
        if file.name in {"runtime.json", "data.json", "local-defaults.json"} or file.suffix == ".pyc" or any(
            part in {"__pycache__", ".git", "node_modules", ".obsidian"} for part in relative.parts
        ):
            continue
        name = "organic-lab-records/" + relative.as_posix()
        windows.append((name, file))
        if relative.as_posix() == "scripts/runtime/node.exe":
            continue
        content = workbuddy_manifest(file.read_text(encoding="utf-8")) if relative.as_posix() == "SKILL.md" else file
        buddy.append((relative.as_posix(), content))
    instructions = project / "portable" / "使用说明.md"
    if not instructions.is_file():
        raise FileNotFoundError("Missing portable/使用说明.md")
    windows.append(("使用说明.md", instructions))
    buddy.append(("使用说明.md", instructions))
    reports = [write_zip(output / "organic-lab-records-windows.zip", windows),
               write_zip(output / "organic-lab-records-workbuddy.zip", buddy)]
    plugin_entries = [("organic-lab-agent/" + name, project / name)
                      for name in ("main.js", "manifest.json", "styles.css")]
    plugin_entries.append(("organic-lab-agent/chemistry_worker.py", project / "python/chemistry_worker.py"))
    plugin_entries.extend(("organic-lab-agent/" + name, project / name)
                          for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"))
    reports.append(write_zip(output / "organic-lab-obsidian-plugin.zip", plugin_entries))
    (output / "使用说明.md").write_bytes(instructions.read_bytes())
    manifest = {"version": json.loads((skill / "bundle.json").read_text(encoding="utf-8"))["version"],
                "archives": reports, "machineConfigurationIncluded": False,
                "userRecordsIncluded": False, "syntheticExamplesIncluded": True, "workbuddyClientImportTested": False}
    (output / "distribution.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
