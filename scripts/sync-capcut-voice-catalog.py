#!/usr/bin/env python3
"""Export the curated CapCut voice catalog from a ViralCrawl capcut_tts.py file."""
import argparse
import importlib.util
import json
import os


def load_module(source):
    spec = importlib.util.spec_from_file_location("viral_capcut_catalog", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load CapCut catalog source")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    module = load_module(os.path.abspath(args.source))
    voices = []
    for language, entries in module.GIONG.items():
        for voice_id, name, resource_id in entries:
            measured_gender = module.gioi_cua(voice_id)
            voices.append({
                "id": voice_id,
                "name": name,
                "lang": language,
                "gender": "male" if measured_gender == "nam" else (
                    "female" if measured_gender == "nu" else "unknown"
                ),
                "resourceId": resource_id,
                "provider": "11labs" if voice_id in module._GIONG_11LABS else "sami",
            })

    document = {
        "schemaVersion": 1,
        "source": "ViralCrawl curated CapCut catalog 2026-08-22",
        "voiceCount": len(voices),
        "defaultsByLanguage": {
            language: entries[0][0]
            for language, entries in module.GIONG.items() if entries
        },
        "voices": voices,
    }
    output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = output + ".tmp"
    with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(document, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(temporary, output)
    print("Exported %d CapCut voices to %s" % (len(voices), output))


if __name__ == "__main__":
    main()
