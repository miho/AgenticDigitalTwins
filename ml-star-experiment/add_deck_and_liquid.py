#!/usr/bin/env python3
"""
Add deck layout model (Phase 3) and liquid class model (Phase 4)
to hamilton-star-digital-twin.json.
"""
import json
import os

BASE = "E:/Users/miho/Dropbox/BFX/ML-API/Hamilton-STAR 2026"

def main():
    path = os.path.join(BASE, "hamilton-star-digital-twin.json")
    with open(path, "r", encoding="utf-8") as f:
        twin = json.load(f)

    # =========================================================================
    # PHASE 3: DECK LAYOUT AND LABWARE MODEL
    # =========================================================================
    twin["deck_layout"] = {
        "description": (
            "The deck is the flat work surface where carriers holding labware are placed. "
            "It uses a track-based positioning system with 22.5mm pitch. Carriers slide "
            "into tracks either manually or via AutoLoad."
        ),
        "platforms": {
            "STAR": {
                "deck_tracks": 54,
                "usable_width_mm": 1215,
                "deck_width_mm": 1667,
                "description": "Full-size platform"
            },
            "STARlet": {
                "deck_tracks": 30,
                "usable_width_mm": 675,
                "deck_width_mm": 1127,
                "description": "Compact platform"
            }
        },
        "track_system": {
            "pitch_mm": 22.5,
            "description": "Parallel slots at 22.5mm spacing. Carriers occupy 1 to 7 tracks.",
            "coordinate_mapping": {
                "track_to_x": "x_mm = (track_number - 1) * 22.5 + offset",
                "note": "Exact offset depends on instrument calibration. FW uses 0.1mm units."
            }
        },
        "carrier_types": {
            "description": "Carriers follow naming convention X_CAR_Y_Ann",
            "naming_convention": {
                "X_prefix": {
                    "TIP": "Tip carrier",
                    "PLT": "Plate carrier",
                    "SMP": "Sample carrier (tubes)",
                    "RGT": "Reagent carrier"
                },
                "Y_suffix": {
                    "L": "Landscape orientation",
                    "P": "Portrait orientation",
                    "number": "Number of items (plates or tips)",
                    "MD": "Medium density (96/384-well)",
                    "HD": "High density (1536-well)",
                    "AC": "Archive format"
                }
            },
            "identification": {
                "method": "Barcode label on back of carrier",
                "format": "Type (3 chars) + Serial (5 chars)",
                "auto_read": "Read automatically during AutoLoad"
            },
            "common_carriers": {
                "TIP_CAR_480": {
                    "description": "Tip carrier, 5 tip rack positions (landscape)",
                    "width_tracks": 6,
                    "positions": 5,
                    "labware_format": "ANSI/SLAS tip rack (96 tips each)"
                },
                "TIP_CAR_480_NTR": {
                    "description": "Tip carrier for Nested Tip Racks (4-layer stacking)",
                    "width_tracks": 6,
                    "positions": 5,
                    "labware_format": "NTR (4x96 = 384 tips per position)"
                },
                "PLT_CAR_L5MD": {
                    "description": "Plate carrier, 5 positions, landscape, medium density",
                    "width_tracks": 6,
                    "positions": 5,
                    "labware_format": "ANSI/SLAS micro plates (96/384-well)"
                },
                "PLT_CAR_L5HD": {
                    "description": "Plate carrier, 5 positions, landscape, high density",
                    "width_tracks": 6,
                    "positions": 5,
                    "labware_format": "ANSI/SLAS 1536-well plates"
                },
                "PLT_CAR_L5AC": {
                    "description": "Plate carrier, 5 positions, landscape, archive",
                    "width_tracks": 6,
                    "positions": 5,
                    "labware_format": "Archive plates"
                },
                "SMP_CAR_32": {
                    "description": "Sample carrier, 32 tube positions",
                    "width_tracks": 1,
                    "positions": 32,
                    "labware_format": "Individual tubes (various diameters)"
                },
                "SMP_CAR_24": {
                    "description": "Sample carrier, 24 tube positions",
                    "width_tracks": 6,
                    "positions": 24,
                    "labware_format": "Individual tubes"
                },
                "RGT_CAR_3R_A00": {
                    "description": "Reagent carrier, 3 trough positions",
                    "width_tracks": 6,
                    "positions": 3,
                    "labware_format": "Reagent troughs"
                }
            },
            "special_carriers": {
                "MultiFlex": {
                    "description": "Modular carrier base for up to 5 ANSI/SLAS modules",
                    "width_tracks": 6,
                    "modules": ["Tip Rack", "Sky Frames", "Plate", "Plate Stacker",
                               "Tip Park", "Lid Park", "Reagent Trough",
                               "Cooling Module", "Heating Module"]
                },
                "Shaker_Carrier_Base": {
                    "description": "Base for Hamilton Heater Shaker + modules",
                    "width_tracks": 7,
                    "max_modules": 4
                },
                "Active_Carrier_Base": {
                    "description": "Plug-in base for Active Plate Nest and ApH Module",
                    "width_tracks": 6
                },
                "CVS_Carrier": {
                    "description": "Crystal Vacuum System carrier with manifold and plate positions",
                    "width_tracks": 7
                },
                "DC_Wash_Station": {
                    "description": "Dual Chamber 96/384 Wash Station",
                    "width_tracks": 6,
                    "chambers": 2
                }
            }
        },
        "labware": {
            "description": (
                "Labware items are placed on carriers. Defined by container geometry "
                "(wells, tubes) and rack layout (rows, columns, spacing)."
            ),
            "labware_types": {
                "micro_plate": {
                    "description": "Standard micro plate in ANSI/SLAS format",
                    "format": "ANSI/SLAS (127.76 x 85.48 mm)",
                    "variants": {
                        "96_well": {"rows": 8, "columns": 12, "well_pitch_mm": 9.0},
                        "384_well": {"rows": 16, "columns": 24, "well_pitch_mm": 4.5},
                        "1536_well": {"rows": 32, "columns": 48, "well_pitch_mm": 2.25}
                    },
                    "max_height_on_deck_mm": 140,
                    "properties": ["well_depth", "well_diameter", "well_volume", "well_shape",
                                  "bottom_type", "material", "barcode"]
                },
                "tip_rack": {
                    "description": "Disposable tip rack in ANSI/SLAS format",
                    "format": "96 tips (8x12)",
                    "tip_sizes_ul": [10, 50, 300, 1000, 4000, 5000],
                    "nested_tip_rack": {
                        "description": "NTR stacks 4 layers of 96 tips",
                        "layers": 4,
                        "total_tips": 384,
                        "requires_transport": "iSWAP or CO-RE Gripper to remove empty frames"
                    }
                },
                "tube": {
                    "description": "Individual sample or reagent tube",
                    "common_types": {
                        "micronic_0.5ml": {"diameter_mm": 7.5, "height_mm": 32},
                        "micronic_1.4ml": {"diameter_mm": 8.0, "height_mm": 47},
                        "eppendorf_1.5ml": {"diameter_mm": 10.8, "height_mm": 40},
                        "falcon_15ml": {"diameter_mm": 17.0, "height_mm": 120},
                        "falcon_50ml": {"diameter_mm": 29.0, "height_mm": 115},
                        "blood_tube_13x75": {"diameter_mm": 13, "height_mm": 75},
                        "blood_tube_13x100": {"diameter_mm": 13, "height_mm": 100}
                    }
                },
                "reagent_trough": {
                    "description": "Reagent reservoir trough",
                    "common_types": {
                        "standard_trough": {"volume_ml": 100, "channels": 1},
                        "divided_trough": {"volume_ml": 25, "channels": 4}
                    }
                }
            },
            "labware_properties": {
                "reference_position": "Corner A1 or first well",
                "height_parameters": {
                    "z_top": "Top of container above deck (used for approach)",
                    "z_bottom": "Bottom of container/well",
                    "z_travel": "Safe height for lateral movement (145mm traverse)"
                },
                "barcode": "Optional barcode on labware for identification"
            }
        },
        "sequences": {
            "description": (
                "Sequences define the order in which wells/positions on labware are accessed. "
                "They are the bridge between the deck layout and the VENUS method steps."
            ),
            "properties": {
                "sequence_name": "User-defined name",
                "labware_reference": "Which labware on which carrier at which track",
                "current_position": "Index into the sequence (advances as channels process)",
                "end_position": "Last position in the sequence",
                "direction": "Column-wise or row-wise traversal"
            },
            "stamp_tool": {
                "description": "Tool for creating sequences in the VENUS editor",
                "patterns": ["column_by_column", "row_by_row", "custom"]
            }
        },
        "tip_waste": {
            "description": "Collection station for used disposable tips",
            "location": "Fixed position on deck (typically rightmost tracks)",
            "types": {
                "tip_waste_bag": "Standard waste bag on deck",
                "tip_waste_chute": "Funnel to external container below instrument"
            }
        }
    }

    # =========================================================================
    # PHASE 4: LIQUID CLASS MODEL
    # =========================================================================
    twin["liquid_classes"] = {
        "description": (
            "Liquid classes define a complete set of aspiration and dispense parameters "
            "optimized for a specific liquid type. They control pipetting speed, air gaps, "
            "LLD settings, and monitoring. Managed via the CO-RE Liquid Editor in VENUS."
        ),
        "concept": {
            "definition": (
                "A liquid class is a named parameter set that tells the firmware HOW to "
                "aspirate and dispense a specific liquid type. The same volume command "
                "(C0AS with av=1000) produces very different physical behavior depending "
                "on the liquid class parameters."
            ),
            "hierarchy": {
                "liquid_type": "Water, DMSO, Ethanol, Blood, Serum, etc.",
                "tip_type": "Parameters vary per tip size (10uL vs 1000uL)",
                "dispense_mode": "Jet vs Surface vs Blow-out, each with different params",
                "volume_range": "Some params change with volume (low-volume corrections)"
            },
            "venus_integration": (
                "In VENUS, the liquid class is selected per step (Aspirate/Dispense). "
                "VENUS translates the liquid class + volume + tip type into the correct "
                "FW command parameters."
            )
        },
        "parameter_categories": {
            "aspiration": {
                "description": "Parameters sent with C0AS command",
                "parameters": {
                    "aspiration_speed_01ul_s": {
                        "fw_param": "as",
                        "description": "Plunger speed during aspiration",
                        "typical_range": [100, 5000],
                        "effect": "Slower = less shear, better for cells; Faster = quicker but may cause bubbles"
                    },
                    "transport_air_01ul": {
                        "fw_param": "ta",
                        "description": "Air gap above liquid column to prevent dripping during transport",
                        "typical_range": [0, 200]
                    },
                    "blow_out_air_01ul": {
                        "fw_param": "ba",
                        "description": "Air pushed through to expel remaining liquid during blow-out",
                        "typical_range": [0, 500]
                    },
                    "pre_wetting_volume_01ul": {
                        "fw_param": "oa",
                        "description": "Volume aspirated and dispensed back before actual aspiration (coats tip interior)",
                        "typical_range": [0, 500]
                    },
                    "lld_mode": {
                        "fw_param": "lm",
                        "description": "Liquid Level Detection mode",
                        "values": {
                            "0": "Off (use fixed Z height)",
                            "1": "cLLD (capacitive)",
                            "2": "pLLD (pressure-based)",
                            "3": "Dual LLD (both)",
                            "4": "Z-touch"
                        }
                    },
                    "clld_sensitivity": {
                        "fw_param": "ll",
                        "description": "Capacitive LLD sensitivity",
                        "values": {"1": "High", "2": "Medium", "3": "Low", "4": "Very Low"}
                    },
                    "swap_speed_01mm_s": {
                        "fw_param": "de",
                        "description": "Z-speed during LLD search descent",
                        "typical_range": [10, 200]
                    },
                    "settling_time_01s": {
                        "fw_param": "wt",
                        "description": "Wait time after positioning before aspirating",
                        "typical_range": [0, 50]
                    },
                    "immersion_depth_01mm": {
                        "fw_param": "ip",
                        "description": "How far below detected liquid surface to position tip",
                        "typical_range": [0, 100]
                    },
                    "surface_following_01mm": {
                        "fw_param": "fp",
                        "description": "Tip follows falling liquid surface during aspiration",
                        "typical_range": [0, 50]
                    }
                }
            },
            "dispense": {
                "description": "Parameters sent with C0DS command",
                "parameters": {
                    "dispense_mode": {
                        "fw_param": "dm",
                        "description": "How liquid is expelled",
                        "values": {
                            "0": "Partial jet (dispense portion, no blow-out, no tip touch)",
                            "1": "Blow-out jet (full dispense with blow-out, no touch)",
                            "2": "Partial surface (dispense portion, touch liquid surface)",
                            "3": "Blow-out surface (full dispense, blow-out, touch surface)",
                            "4": "Empty tip (dump everything)"
                        }
                    },
                    "dispense_speed_01ul_s": {
                        "fw_param": "ds",
                        "description": "Plunger speed during dispense",
                        "typical_range": [100, 5000]
                    },
                    "cutoff_speed_01ul_s": {
                        "fw_param": "ss",
                        "description": "Plunger speed at the end of dispense (for precise cutoff)",
                        "typical_range": [50, 500]
                    },
                    "stop_back_volume_01ul": {
                        "fw_param": "rv",
                        "description": "Small reverse plunger movement after dispense to prevent dripping",
                        "typical_range": [0, 100]
                    },
                    "side_touch_off": {
                        "fw_param": "dj",
                        "description": "Touch tip against vessel wall after dispense to break droplet",
                        "values": {"0": "Off", "1": "On"}
                    }
                }
            },
            "mixing": {
                "description": "Parameters for in-place mixing (aspirate+dispense cycles)",
                "parameters": {
                    "mixing_volume_01ul": {"fw_param": "mv", "description": "Volume per mix cycle"},
                    "mixing_cycles": {"fw_param": "mc", "description": "Number of asp+disp cycles"},
                    "mixing_speed_01ul_s": {"fw_param": "ms", "description": "Plunger speed during mixing"},
                    "mixing_position_01mm": {"fw_param": "mp", "description": "Z offset for mixing position"},
                    "mixing_height_01mm": {"fw_param": "mh", "description": "Vertical range of mixing"}
                }
            },
            "tadm": {
                "description": "Total Aspiration and Dispense Monitoring parameters",
                "parameters": {
                    "tadm_channel_pattern": {"fw_param": "gi", "description": "Which channels are TADM-monitored"},
                    "tadm_upper_tolerance": {"fw_param": "gj", "description": "Upper pressure tolerance band"},
                    "tadm_lower_tolerance": {"fw_param": "gk", "description": "Lower pressure tolerance band"}
                }
            }
        },
        "standard_liquid_classes": {
            "description": "Hamilton ships standard liquid classes for common liquids. Custom classes can be derived.",
            "examples": {
                "Water_HighVolumeJet_Empty": {
                    "liquid_type": "Water",
                    "dispense_mode": "Blow-out jet",
                    "volume_range": "high (>50uL)",
                    "use_case": "Standard water transfer with full blow-out"
                },
                "Water_LowVolumeJet_Empty": {
                    "liquid_type": "Water",
                    "dispense_mode": "Blow-out jet",
                    "volume_range": "low (<50uL)",
                    "use_case": "Small-volume water transfer"
                },
                "Water_HighVolumeSurface_Part": {
                    "liquid_type": "Water",
                    "dispense_mode": "Partial surface",
                    "volume_range": "high",
                    "use_case": "Multi-dispense (aliquoting) into liquid"
                },
                "DMSO_HighVolumeJet_Empty": {
                    "liquid_type": "DMSO",
                    "dispense_mode": "Blow-out jet",
                    "volume_range": "high",
                    "use_case": "DMSO transfer (higher viscosity, slower speeds)"
                },
                "Serum_HighVolumeSurface_Empty": {
                    "liquid_type": "Serum",
                    "dispense_mode": "Blow-out surface",
                    "volume_range": "high",
                    "use_case": "Serum transfer (tendency to foam, surface dispense)"
                },
                "Blood_HighVolumeSurface_Empty": {
                    "liquid_type": "Blood",
                    "dispense_mode": "Blow-out surface",
                    "volume_range": "high",
                    "use_case": "Blood transfer (viscous, clot risk, surface dispense)"
                },
                "Glycerol80_HighVolumeSurface_Empty": {
                    "liquid_type": "80% Glycerol",
                    "dispense_mode": "Blow-out surface",
                    "volume_range": "high",
                    "use_case": "Highly viscous liquid (slow speeds, large blow-out)"
                },
                "Ethanol_HighVolumeJet_Empty": {
                    "liquid_type": "Ethanol",
                    "dispense_mode": "Blow-out jet",
                    "volume_range": "high",
                    "use_case": "Volatile liquid (ADC enabled, fast transport)"
                }
            }
        },
        "adc_anti_droplet_control": {
            "description": (
                "ADC prevents cross-contamination by compensating pressure changes "
                "caused by volatile liquids (ethanol, acetonitrile). Real-time piston "
                "micro-adjustments maintain air cushion integrity during transport."
            ),
            "applicable_to": ["1000uL channels", "5mL channels", "X1 channels"],
            "not_applicable_to": ["CO-RE 96 Head", "CO-RE 384 Head"]
        }
    }

    # Update metadata and roadmap
    twin["metadata"]["version"] = "0.3.0"
    for phase in twin.get("roadmap", {}).get("phases", []):
        if phase.get("phase") in [3, 4]:
            phase["status"] = "done"

    # Save
    with open(path, "w", encoding="utf-8") as f:
        json.dump(twin, f, indent=2, ensure_ascii=False)
    print(f"Written: {path} ({os.path.getsize(path):,} bytes)")
    print(f"Added: deck_layout, liquid_classes")
    print(f"Version: 0.3.0")

if __name__ == "__main__":
    main()
