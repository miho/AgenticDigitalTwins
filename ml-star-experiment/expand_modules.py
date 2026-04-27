#!/usr/bin/env python3
"""
Expand all stubbed modules in hamilton-star-digital-twin.json
with full command detail from the extracted FW command specs.
"""
import json
import sys
import os

BASE = "E:/Users/miho/Dropbox/BFX/ML-API/Hamilton-STAR 2026"

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Written: {path} ({os.path.getsize(path):,} bytes)")

# Map stubbed module IDs to their source doc IDs in the extracted JSON
MODULE_TO_DOCS = {
    "core384_head":          ["E289241a"],
    "xl_channels":           ["E289243a"],
    "nano_dispenser":        ["E289240a"],
    "tube_gripper":          [],  # Commands in Master Module doc
    "gel_card_gripper":      ["E289251a"],
    "image_channel":         ["E289245a"],
    "robotic_channels":      ["E289246a"],  # Cap Handler = robotic channels
    "decapper_module":       ["E2891018a"],
    "puncher":               ["E2891010a", "E2891011a"],  # CardPuncher + CardHandler
    "head_gripper":          ["E289244a"],
    "heater_shaker":         ["E289247a"],
    "heater_module":         ["E2891021a"],
    "washer96":              ["E2891013a"],
    "centrifuge":            ["E2891023a"],
    "gel_card_incubator":    ["E2891022a"],
    "rd5_process_unit":      ["E2891016a"],
    "rd5_loading_unit":      ["E2891017a"],
    "autoload_2d":           ["E2891024a"],
    "pipetting_head_squeezer": ["E2891026a"],
    "pressure_controller":   ["E289242a"],
    "x0_module":             ["E289003a", "E2891005a"],
    "light_controller":      [],  # PDF only, no extraction
    # Also expand core modules with slave-level diagnostic commands
    "pump_unit":             ["E289019a"],
}

# Additional: expand core modules that had operational commands only
CORE_ENRICHMENT = {
    "pipetting_channels":    ["E289005a"],       # PIP slave diagnostics
    "core96_head":           ["E289018a", "E2891003a"],  # 96Head slave
    "iswap":                 ["E289015a"],        # iSWAP slave
    "autoload":              ["E289004a", "E2891024a"],  # AutoLoad slave + 2D
    "wash_station":          ["E289007a"],        # Wash slave
    "temperature_carrier":   ["E289008a"],        # TCC slave
}


def format_command(cmd_code, cmd_data):
    """Convert extracted command to digital twin format."""
    if isinstance(cmd_data, str):
        return {"name": cmd_code, "description": cmd_data}

    result = {"name": cmd_code}

    if "description" in cmd_data:
        result["description"] = cmd_data["description"]

    if "parameters" in cmd_data and cmd_data["parameters"]:
        params = {}
        for p in cmd_data["parameters"]:
            if isinstance(p, dict) and "name" in p:
                param_entry = {}
                if "description" in p:
                    param_entry["description"] = p["description"]
                if "range" in p:
                    param_entry["range"] = p["range"]
                if "type" in p:
                    param_entry["format"] = p["type"]
                params[p["name"]] = param_entry
        if params:
            result["parameters"] = params

    return result


def format_errors(error_dict):
    """Convert error codes to digital twin format."""
    result = {}
    for code, desc in error_dict.items():
        if isinstance(desc, str):
            result[code] = desc
        elif isinstance(desc, dict):
            result[code] = desc.get("description", str(desc))
    return result


def expand_module(twin_module, doc_ids, extracted):
    """Expand a module with full command detail from extracted docs."""
    all_commands = {}
    all_errors = {}
    doc_refs = []

    for doc_id in doc_ids:
        doc = extracted.get(doc_id)
        if not doc:
            continue

        doc_refs.append(f"{doc_id} ({doc.get('module_name', '?')})")

        # Merge commands
        for cmd_code, cmd_data in doc.get("commands", {}).items():
            if cmd_code not in all_commands:
                all_commands[cmd_code] = format_command(cmd_code, cmd_data)

        # Merge error codes
        for err_code, err_desc in doc.get("error_codes", {}).items():
            if err_code not in all_errors:
                if isinstance(err_desc, str):
                    all_errors[err_code] = err_desc
                elif isinstance(err_desc, dict):
                    all_errors[err_code] = err_desc.get("description", str(err_desc))

    if all_commands:
        twin_module["commands"] = all_commands
        twin_module["command_count"] = len(all_commands)
    if all_errors:
        twin_module["error_codes"] = all_errors
    if doc_refs:
        twin_module["doc_ref"] = " + ".join(doc_refs)

    # Remove stub markers
    twin_module.pop("status", None)
    twin_module.pop("command_codes", None)

    return len(all_commands)


def enrich_core_module(twin_module, doc_ids, extracted):
    """Add slave-level diagnostic commands to a core module that already has operational commands."""
    slave_commands = {}

    for doc_id in doc_ids:
        doc = extracted.get(doc_id)
        if not doc:
            continue

        for cmd_code, cmd_data in doc.get("commands", {}).items():
            slave_commands[cmd_code] = format_command(cmd_code, cmd_data)

        # Add slave error codes if not present
        if "slave_error_codes" not in twin_module:
            errs = doc.get("error_codes", {})
            if errs:
                formatted = {}
                for ec, ed in errs.items():
                    formatted[ec] = ed if isinstance(ed, str) else ed.get("description", str(ed))
                twin_module["slave_error_codes"] = formatted

    if slave_commands:
        twin_module["slave_diagnostic_commands"] = slave_commands
        twin_module["slave_command_count"] = len(slave_commands)

    return len(slave_commands)


def main():
    print("Loading digital twin spec...")
    twin = load_json(os.path.join(BASE, "hamilton-star-digital-twin.json"))

    print("Loading extracted FW commands...")
    extracted = load_json(os.path.join(BASE, "Command sets (13.04.2026)", "hamilton_command_specs_extracted.json"))

    modules = twin["modules"]
    total_expanded = 0
    total_enriched = 0

    # Expand stubbed modules
    print("\n--- Expanding stubbed modules ---")
    for mod_id, doc_ids in MODULE_TO_DOCS.items():
        if mod_id not in modules:
            print(f"  SKIP {mod_id}: not in twin spec")
            continue
        if not doc_ids:
            print(f"  SKIP {mod_id}: no source docs")
            continue

        count = expand_module(modules[mod_id], doc_ids, extracted)
        total_expanded += count
        print(f"  {mod_id}: {count} commands expanded")

    # Enrich core modules with slave diagnostics
    print("\n--- Enriching core modules with slave diagnostics ---")
    for mod_id, doc_ids in CORE_ENRICHMENT.items():
        if mod_id not in modules:
            print(f"  SKIP {mod_id}: not in twin spec")
            continue

        count = enrich_core_module(modules[mod_id], doc_ids, extracted)
        total_enriched += count
        print(f"  {mod_id}: {count} slave commands added")

    # Update metadata
    twin["metadata"]["version"] = "0.2.0"
    twin["metadata"]["coverage"]["status"] = "all_modules_expanded"
    twin["metadata"]["coverage"]["total_commands"] = total_expanded + total_enriched

    # Update roadmap
    for phase in twin.get("roadmap", {}).get("phases", []):
        if phase.get("phase") == 2:
            phase["status"] = "done"

    print(f"\n--- Summary ---")
    print(f"  Stubbed modules expanded: {len(MODULE_TO_DOCS)} modules, {total_expanded} commands")
    print(f"  Core modules enriched: {len(CORE_ENRICHMENT)} modules, {total_enriched} slave commands")
    print(f"  Total new commands: {total_expanded + total_enriched}")

    # Save
    print("\nSaving...")
    save_json(os.path.join(BASE, "hamilton-star-digital-twin.json"), twin)
    print("Done.")


if __name__ == "__main__":
    main()
