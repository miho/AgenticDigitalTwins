#!/usr/bin/env python3
"""
Build the Hamilton STAR Digital Twin JSON specification.
Merges data from:
  - FW command set documents (extracted)
  - VENUS source code analysis
  - Operator's Manual hardware descriptions
"""
import json
import sys
import os
from collections import OrderedDict

def build():
    spec = OrderedDict()

    # =========================================================================
    # METADATA
    # =========================================================================
    spec["$schema"] = "hamilton-star-digital-twin-v1"
    spec["metadata"] = {
        "title": "Hamilton Microlab STAR Digital Twin Specification",
        "version": "0.1.0",
        "created": "2026-04-13",
        "description": (
            "Machine-readable specification of the Hamilton Microlab STAR liquid handling "
            "system at the firmware command level. Maps physical hardware modules to firmware "
            "commands to VENUS software steps. Designed for digital twin simulation and "
            "accessible to both humans and coding agents."
        ),
        "sources": {
            "operators_manual": "10187420_00_Microlab STAR Line with VENUS 6-3_OperatorsManual_en.pdf",
            "programmers_manual": "10193682_00 VENUS 6-3 Software Programmer's Manual.pdf",
            "fw_command_docs": "Command sets (13.04.2026)/ — 36 documents",
            "venus_source": "VENUS-2026-04-13/ — Star/src/HxAtsInstrument, HxGruCommand"
        },
        "coverage": {
            "status": "core_workflow_complete",
            "core_modules_detailed": [
                "master", "pipetting_channels", "core96_head",
                "autoload", "iswap", "core_gripper",
                "wash_station", "temperature_carrier"
            ],
            "modules_stubbed": [
                "core384_head", "xl_channels", "nano_dispenser",
                "head_gripper", "gel_card_gripper", "punch_card_gripper",
                "forensic_tube_gripper", "tube_twister", "micronics_tube_gripper",
                "decapper", "puncher", "heater_shaker", "heater_module",
                "washer96", "washer96_liquid_unit", "pump_station",
                "pressure_controller", "image_channel", "cap_handler",
                "light_controller", "x0_module", "download_module",
                "rd5_process_unit", "rd5_loading_unit", "gel_card_incubator",
                "centrifuge", "autoload_2d", "pipetting_head_squeezer"
            ]
        }
    }

    # =========================================================================
    # SYSTEM / PLATFORM
    # =========================================================================
    spec["system"] = {
        "platform": {
            "name": "Microlab STAR Line",
            "variants": {
                "STAR": {"deck_tracks": 54, "width_mm": 1667, "width_with_mph_mm": 1930},
                "STARlet": {"deck_tracks": 30, "width_mm": 1127, "width_with_mph_mm": 1390}
            },
            "common_specs": {
                "height_mm": 905,
                "depth_manual_load_mm": 784,
                "depth_autoload_mm": 1011,
                "track_pitch_mm": 22.5,
                "max_labware_height_mm": 140,
                "traverse_height_mm": 145,
                "positional_accuracy_mm": 0.1,
                "noise_operating_dba": 65,
                "noise_standby_dba": 46,
                "lifetime_years": 7,
                "power_single_supply_va": 600,
                "power_dual_supply_va": 1000,
                "voltage_ranges": ["100-120 VAC", "220-240 VAC"],
                "frequency_hz": [50, 60],
                "ambient_temp_operating_c": [15, 35],
                "ambient_humidity_percent": [15, 85]
            }
        },
        "communication": {
            "protocol": "CAN bus (internal), USB/Ethernet (host)",
            "host_interface": {
                "usb": "Dual Processor Board",
                "ethernet": "LAN Dual Processor Board"
            },
            "command_format": {
                "description": "All commands sent as ASCII strings to Master Module (C0)",
                "structure": "<module_prefix><command_code>id<nnnn><param_key><value>...",
                "module_prefix": "2 uppercase characters identifying the target module",
                "command_code": "2 uppercase characters identifying the operation",
                "id": "4-digit order identifier for async tracking",
                "parameters": "2 lowercase chars + value, order flexible after id",
                "example": "C0ASid0001tm1at0xp02980yp1460th2450te2450"
            },
            "response_format": {
                "success": "<module_prefix><command_code>id<nnnn>er00/00",
                "error": "<module_prefix><command_code>id<nnnn>er<main>/<detail>",
                "slave_error": "er99/00 <slave_prefix><slave_err>/<detail>"
            }
        },
        "deck": {
            "description": "Flat work surface with track-based positioning",
            "coordinate_system": {
                "x_axis": "Left-right along the arm rail (0.1mm units in FW)",
                "y_axis": "Front-back perpendicular to arm (0.1mm units in FW)",
                "z_axis": "Vertical up-down (0.1mm units in FW)"
            },
            "components": {
                "tracks": "Parallel slots at 22.5mm pitch for carrier placement",
                "carriers": "Removable trays holding labware, identified by barcode",
                "labware": "Plates, tubes, tip racks placed on carriers",
                "tip_waste": "Collection station for used disposable tips"
            }
        }
    }

    # =========================================================================
    # ERROR CODES (Master Module - shared across all commands)
    # =========================================================================
    spec["error_codes"] = {
        "00": "No error",
        "01": "Syntax error",
        "02": "Hardware error (drive blocked, low power)",
        "03": "Command not completed (error in previous sequence)",
        "04": "Clot detected (LLD not interrupted)",
        "05": "Barcode unreadable",
        "06": "Too little liquid (surface not detected)",
        "07": "Tip already fitted",
        "08": "No tip (command requires fitted tip)",
        "09": "No carrier (load command without carrier present)",
        "10": "Not completed (aborted due to prior error)",
        "11": "Dispense with pressure LLD not permitted",
        "12": "No teach-in signal (max position reached)",
        "13": "Loading tray error (position occupied)",
        "14": "Sequenced aspiration with pressure LLD not permitted",
        "15": "Not allowed parameter combination",
        "16": "Cover close error",
        "17": "Aspiration error (liquid stream error)",
        "18": "Wash fluid or waste error",
        "19": "Incubation error (temperature out of limit)",
        "20": "TADM measurement error (overshoot)",
        "21": "No element (expected element not detected)",
        "22": "Element still holding",
        "23": "Element lost",
        "24": "Illegal target plate position (iSWAP overflow)",
        "25": "Illegal user access (carrier removed or cover open)",
        "26": "TADM measurement error (limit exceeded)",
        "27": "Position not reachable (out of mechanical limits)",
        "28": "Unexpected LLD (liquid level before scan started)",
        "29": "Area already occupied",
        "30": "Impossible to occupy area",
        "31": "ADC error",
        "32": "Decapper cause error",
        "33": "Decapper handling error",
        "80": "Download error",
        "99": "Slave error (error in one of the slaves)"
    }

    # =========================================================================
    # MODULES
    # =========================================================================
    spec["modules"] = OrderedDict()

    # -------------------------------------------------------------------------
    # MASTER MODULE
    # -------------------------------------------------------------------------
    spec["modules"]["master"] = {
        "name": "Master Module",
        "fw_prefix": "C0",
        "doc_ref": "E2891001a.docx / E289002a.doc",
        "description": (
            "Central controller on the LAN Dual Processor Board. Receives all commands "
            "from the host computer via USB/Ethernet and orchestrates slave modules over CAN bus. "
            "All operational commands (pipetting, transport, loading) are addressed to C0."
        ),
        "state_model": {
            "states": [
                "power_off", "initializing", "idle", "running", "paused",
                "error", "single_step", "download_mode"
            ],
            "transitions": [
                {"from": "power_off", "to": "initializing", "trigger": "power_on"},
                {"from": "initializing", "to": "idle", "trigger": "VI_complete"},
                {"from": "idle", "to": "running", "trigger": "command_received"},
                {"from": "running", "to": "idle", "trigger": "command_complete"},
                {"from": "running", "to": "paused", "trigger": "pause_request"},
                {"from": "paused", "to": "running", "trigger": "resume_request"},
                {"from": "running", "to": "error", "trigger": "error_detected"},
                {"from": "error", "to": "idle", "trigger": "error_cleared"},
                {"from": "idle", "to": "single_step", "trigger": "AM_enable"},
                {"from": "single_step", "to": "idle", "trigger": "AM_disable"},
                {"from": "idle", "to": "download_mode", "trigger": "AP_command"},
                {"from": "download_mode", "to": "idle", "trigger": "AP_run_mode"}
            ]
        },
        "commands": {
            "system": {
                "VI": {
                    "name": "Pre-Initialize Instrument",
                    "description": "Initialize all Z-drives then X-drives in parallel. Must be first command after power-on.",
                    "parameters": {},
                    "response": {"er": "error_code"},
                    "venus_step": "Run_Initialize"
                },
                "RF": {
                    "name": "Request Firmware Version",
                    "description": "Returns firmware version string",
                    "parameters": {},
                    "response": {"rf": "firmware_version_string"}
                },
                "RE": {
                    "name": "Request Error Code",
                    "description": "Returns error codes from all configured nodes",
                    "parameters": {},
                    "response": {"er": "error_code_per_node"}
                },
                "RA": {
                    "name": "Request Parameter Value",
                    "description": "Query a specific parameter value",
                    "parameters": {},
                    "response": {"value": "parameter_value"}
                },
                "QB": {
                    "name": "Request Electronic Board Type",
                    "description": "Returns board identification",
                    "parameters": {},
                    "response": {"qb": "board_type"}
                },
                "MU": {
                    "name": "Request Supply Voltage",
                    "description": "LDPB only - returns supply voltage reading",
                    "parameters": {},
                    "response": {"mu": "voltage"}
                },
                "QW": {
                    "name": "Request Initialization Status",
                    "description": "Returns whether instrument is initialized",
                    "parameters": {},
                    "response": {"qw": "0=not_init|1=initialized"}
                },
                "VP": {
                    "name": "Request Last Faulty Parameter",
                    "description": "Returns name of the parameter that caused the last error",
                    "parameters": {},
                    "response": {"vp": "parameter_name"}
                },
                "RQ": {
                    "name": "Request Master Status",
                    "description": "Returns hex bitmask of master state",
                    "parameters": {},
                    "response": {"rq": "hex_status_bitmask"}
                },
                "SR": {
                    "name": "Request Number of Presence Sensors",
                    "description": "Returns count of installed presence sensors",
                    "parameters": {},
                    "response": {"sr": "sensor_count"}
                },
                "QV": {
                    "name": "Request EEPROM Data Correctness",
                    "description": "Validates stored EEPROM data integrity",
                    "parameters": {},
                    "response": {"qv": "0=ok|1=error"}
                }
            },
            "settings_volatile": {
                "AM": {
                    "name": "Set Single Step Mode",
                    "description": "Enable or disable single-step execution mode",
                    "parameters": {
                        "am": {"type": "int", "range": [0, 1], "description": "0=off, 1=on"}
                    }
                },
                "NS": {
                    "name": "Trigger Next Step",
                    "description": "Execute next command in single-step mode",
                    "parameters": {}
                },
                "HD": {
                    "name": "Halt",
                    "description": "Discard queued commands, complete current command",
                    "parameters": {}
                },
                "AZ": {
                    "name": "Save All Cycle Counters",
                    "description": "Persist current cycle counter values to EEPROM",
                    "parameters": {}
                },
                "AB": {
                    "name": "Not Stop ON (Emergency Stop)",
                    "description": "Activate emergency stop state",
                    "parameters": {}
                },
                "AW": {
                    "name": "Not Stop OFF",
                    "description": "Release emergency stop state",
                    "parameters": {}
                }
            },
            "settings_nonvolatile": {
                "SI": {
                    "name": "Store Installation Data",
                    "description": "Save installation data to EEPROM",
                    "parameters": {"si": {"type": "string", "description": "Installation data string"}}
                },
                "AV": {
                    "name": "Store Verification Data",
                    "description": "Save verification/calibration data",
                    "parameters": {"av": {"type": "string", "description": "Verification data"}}
                },
                "AT": {
                    "name": "Additional Time Stamp",
                    "description": "Store additional timestamp data",
                    "parameters": {"at": {"type": "string", "description": "Timestamp data"}}
                },
                "AK": {
                    "name": "Set Instrument Configuration",
                    "description": "Save instrument hardware configuration to EEPROM",
                    "parameters": {"ak": {"type": "string", "description": "Configuration data"}}
                },
                "DD": {
                    "name": "Set Deck Data",
                    "description": "Store deck layout configuration",
                    "parameters": {"dd": {"type": "string", "description": "Deck data"}}
                },
                "XK": {
                    "name": "Configure Node Names",
                    "description": "Set CAN node name mapping",
                    "parameters": {"xk": {"type": "string", "description": "Node name config"}}
                },
                "TT": {
                    "name": "Tip/Needle Definition",
                    "description": "Define tip type parameters for a tip type index",
                    "parameters": {
                        "tt": {"type": "int", "range": [0, 99], "unit": "index", "description": "Tip type index"},
                        "tf": {"type": "int", "range": [0, 1], "description": "0=no filter, 1=filter tip"},
                        "tl": {"type": "int", "range": [1, 1999], "unit": "0.1mm", "description": "Tip length"},
                        "tv": {"type": "int", "range": [1, 56000], "unit": "0.1ul", "description": "Maximum volume"},
                        "tg": {"type": "int", "range": [0, 9], "description": "Tip collar type"},
                        "tu": {"type": "int", "range": [0, 1], "description": "Pick up method (0=auto, 1=manual)"}
                    }
                },
                "AG": {"name": "Set X-offset iSWAP", "description": "Store iSWAP X-axis offset", "parameters": {"ag": {"type": "int", "unit": "0.1mm", "description": "X offset"}}},
                "AF": {"name": "Set X-offset CoRe 96 Head", "description": "Store 96 head X-axis offset", "parameters": {"af": {"type": "int", "unit": "0.1mm", "description": "X offset"}}},
                "AD": {"name": "Set X-offset CoRe 384 Head", "description": "Store 384 head X-axis offset", "parameters": {"ad": {"type": "int", "unit": "0.1mm", "description": "X offset"}}},
                "AN": {"name": "Set X-offset Nano Pipettor", "description": "Store Nano head X-axis offset", "parameters": {"an": {"type": "int", "unit": "0.1mm", "description": "X offset"}}},
                "AJ": {"name": "Save PIP Channel Validation Status", "description": "Store channel validation state", "parameters": {"aj": {"type": "string", "description": "Validation data"}}},
                "AE": {"name": "Save XL Channel Validation Status", "description": "Store XL channel validation state", "parameters": {"ae": {"type": "string", "description": "Validation data"}}},
                "IP": {"name": "Save TCP/IP Parameters", "description": "LDPB only - store network config", "parameters": {"ip": {"type": "string", "description": "IP config data"}}},
                "AO": {"name": "Save Download Date", "description": "Store firmware download date", "parameters": {"ao": {"type": "string", "description": "Date string"}}},
                "BT": {"name": "Save Technical Status", "description": "Store technical status of assemblies", "parameters": {"bt": {"type": "string", "description": "Technical status data"}}},
                "AU": {"name": "Set USB Device Number", "description": "LDPB only", "parameters": {"au": {"type": "int", "description": "USB device number"}}}
            },
            "settings_queries": {
                "QT": {"name": "Request Technical Status", "description": "Returns technical status of assemblies", "parameters": {}, "response": {"qt": "technical_data"}},
                "RI": {"name": "Request Installation Data", "description": "Returns stored installation data", "parameters": {}, "response": {"ri": "installation_data"}},
                "RO": {"name": "Request Download Date", "description": "Returns firmware download date", "parameters": {}, "response": {"ro": "date_string"}},
                "RV": {"name": "Request Verification Data", "description": "Returns stored verification data", "parameters": {}, "response": {"rv": "verification_data"}},
                "RS": {"name": "Request Additional Timestamp", "description": "Returns stored timestamp data", "parameters": {}, "response": {"rs": "timestamp_data"}},
                "RJ": {"name": "Request PIP Channel Validation", "description": "Returns channel validation status", "parameters": {}, "response": {"rj": "validation_data"}},
                "UJ": {"name": "Request XL Channel Validation", "description": "Returns XL channel validation status", "parameters": {}, "response": {"uj": "validation_data"}},
                "RM": {"name": "Request Instrument Configuration", "description": "Returns stored hardware config", "parameters": {}, "response": {"rm": "config_data"}},
                "QM": {"name": "Request Extended Configuration", "description": "Returns extended instrument config", "parameters": {}, "response": {"qm": "extended_config"}},
                "VD": {"name": "Request Deck Data", "description": "Returns stored deck configuration", "parameters": {}, "response": {"vd": "deck_data"}},
                "RK": {"name": "Request Node Names", "description": "Returns CAN node name mapping", "parameters": {}, "response": {"rk": "node_name_data"}}
            },
            "x_axis_control": {
                "JX": {
                    "name": "Position Left X-Arm Absolute",
                    "description": "Move left X-arm to absolute position. COLLISION RISK - no Z-safety check.",
                    "parameters": {
                        "xs": {"type": "int", "range": [0, 30000], "unit": "0.1mm", "description": "Target X-position"}
                    },
                    "response": {"er": "error_code"}
                },
                "JS": {
                    "name": "Position Right X-Arm Absolute",
                    "description": "Move right X-arm to absolute position. COLLISION RISK.",
                    "parameters": {
                        "xs": {"type": "int", "range": [0, 30000], "unit": "0.1mm", "description": "Target X-position"}
                    }
                },
                "KX": {
                    "name": "Move Left X-Arm Safe",
                    "description": "Move left X-arm with Z-safety check first (raises Z before moving X)",
                    "parameters": {
                        "xs": {"type": "int", "range": [0, 30000], "unit": "0.1mm", "description": "Target X-position"}
                    }
                },
                "KR": {
                    "name": "Move Right X-Arm Safe",
                    "description": "Move right X-arm with Z-safety check first",
                    "parameters": {
                        "xs": {"type": "int", "range": [0, 30000], "unit": "0.1mm", "description": "Target X-position"}
                    }
                },
                "BA": {
                    "name": "Occupy Area for External Access",
                    "description": "Reserve an X-range for external device access",
                    "parameters": {
                        "ba": {"type": "int", "unit": "0.1mm", "description": "Start of area"},
                        "bb": {"type": "int", "unit": "0.1mm", "description": "End of area"}
                    }
                },
                "BB": {"name": "Release Occupied Area", "description": "Release a previously reserved area", "parameters": {}},
                "BC": {"name": "Release All Occupied Areas", "description": "Release all reserved areas", "parameters": {}},
                "RX": {"name": "Request Left X-Arm Position", "description": "Returns current position", "parameters": {}, "response": {"rx": "position_0.1mm"}},
                "QX": {"name": "Request Right X-Arm Position", "description": "Returns current position", "parameters": {}, "response": {"qx": "position_0.1mm"}},
                "RU": {"name": "Request X-Drive Ranges", "description": "Returns max travel ranges", "parameters": {}, "response": {"ru": "range_data"}},
                "UA": {"name": "Request Arm Wrap Size", "description": "Returns installed arm widths", "parameters": {}, "response": {"ua": "wrap_size_data"}}
            },
            "download": {
                "AP": {"name": "Switch Download/Run Mode", "description": "Toggle between firmware download mode and run mode", "parameters": {}},
                "DE": {"name": "Start Download", "description": "Begin firmware download procedure", "parameters": {}},
                "DP": {"name": "Program Flash Line", "description": "Program one Intel HEX line to flash EPROM", "parameters": {"dp": {"type": "string", "max_length": 1200, "description": "Intel HEX line data"}}}
            },
            "status_light": {
                "ST": {
                    "name": "Set Status Light",
                    "description": "Control instrument status light bar",
                    "parameters": {
                        "sp": {"type": "int", "range": [0, 100], "description": "Intensity 0-100%"},
                        "sf": {"type": "int", "range": [0, 3], "description": "Color: 0=white, 1=red, 2=green, 3=blue"},
                        "so": {"type": "int", "range": [0, 5], "description": "Progress: 0=off, 1-5=20/40/60/80/100%"},
                        "sj": {"type": "int", "description": "Blink interval (0=steady)"}
                    },
                    "venus_step": "Run_SetStatusLight"
                },
                "SS": {
                    "name": "Set Interior Light",
                    "description": "Control instrument interior lighting",
                    "parameters": {
                        "sm": {"type": "int", "range": [0, 2], "description": "Mode"},
                        "sp": {"type": "int", "range": [0, 100], "description": "Intensity"}
                    }
                },
                "SL": {
                    "name": "Set Logo Light",
                    "description": "Control Hamilton logo illumination",
                    "parameters": {
                        "sp": {"type": "int", "range": [0, 100], "description": "Intensity"}
                    }
                },
                "WL": {"name": "Request Logo Light State", "parameters": {}, "response": {"wl": "state"}},
                "WJ": {"name": "Request Interior Light State", "parameters": {}, "response": {"wj": "state"}}
            },
            "cover_control": {
                "HO": {"name": "Unlock Cover", "description": "Unlock the front cover", "parameters": {}, "venus_step": "Run_LockFrontCover"},
                "CO": {"name": "Lock Cover", "description": "Lock the front cover", "parameters": {}},
                "CD": {"name": "Disable Cover Control", "description": "Disable automatic cover monitoring", "parameters": {}},
                "CE": {"name": "Enable Cover Control", "description": "Re-enable automatic cover monitoring", "parameters": {}},
                "QC": {"name": "Request Cover Position", "description": "Returns cover open/closed state", "parameters": {}, "response": {"qc": "0=closed|1=open"}}
            },
            "port_io": {
                "OS": {"name": "Set Output", "description": "Set a digital output port", "parameters": {"os": {"type": "int", "description": "Output port/value"}}, "venus_step": "Run_WritePort"},
                "OR": {"name": "Reset Output", "description": "Clear a digital output port", "parameters": {"or": {"type": "int", "description": "Output port"}}},
                "AC": {"name": "Set Traffic Lights", "description": "Control external traffic light signals", "parameters": {"ac": {"type": "int", "description": "Light pattern"}}},
                "RW": {"name": "Query Input Status", "description": "Read digital input ports", "parameters": {}, "response": {"rw": "input_state"}, "venus_step": "Run_ReadPort"}
            },
            "service": {
                "GO": {"name": "Synchronization Command", "description": "Trigger CAN Object 4 for sync", "parameters": {}},
                "AH": {"name": "Wait Sync PIP Channels", "description": "Wait for synchronization with PIP channels", "parameters": {}},
                "AL": {"name": "Wait Sync XL Channels", "description": "Wait for synchronization with XL channels", "parameters": {}},
                "RH": {"name": "Heap Query", "description": "Debug - query memory heap state", "parameters": {}},
                "AI": {"name": "Reset", "description": "Software reset of master module", "parameters": {}},
                "AA": {"name": "Set Debug Parameters", "description": "Configure debug output settings", "parameters": {}}
            }
        }
    }

    # -------------------------------------------------------------------------
    # PIPETTING CHANNELS (PIP) - Commands via C0, diagnostics via Px
    # -------------------------------------------------------------------------
    spec["modules"]["pipetting_channels"] = {
        "name": "Pipetting Channels (1000 uL / PIP)",
        "fw_prefix": "C0 (operational) / P1-PG (diagnostics per channel)",
        "doc_ref": "E2891001a.docx (Master), E289005a.doc (PIP channel)",
        "description": (
            "Up to 16 independent 1000uL air-displacement pipetting channels. Each channel "
            "has independent Y and Z drives. Tips attached via CO-RE compression O-ring technology. "
            "Supports cLLD, pLLD, MAD, ADC, TADM monitoring."
        ),
        "hardware": {
            "max_channels": 16,
            "nominal_volume_ul": 1000,
            "tip_sizes_ul": [10, 50, 300, 1000],
            "min_channel_distance_mm": 9,
            "traverse_height_mm": 145,
            "tip_attachment": "CO-RE (Compression-induced O-Ring Expansion)",
            "monitoring": ["cLLD", "pLLD", "MAD", "ADC", "TADM"],
            "pipetting_specs": {
                "10ul_tip": {"0.5ul": {"trueness_pct": 10.0, "cv_pct": 6.0}, "1ul": {"trueness_pct": 5.0, "cv_pct": 4.0}, "5ul": {"trueness_pct": 2.5, "cv_pct": 1.5}, "10ul": {"trueness_pct": 1.5, "cv_pct": 1.0}},
                "50ul_tip": {"0.5ul": {"trueness_pct": 10.0, "cv_pct": 6.0}, "1ul": {"trueness_pct": 5.0, "cv_pct": 4.0}, "5ul": {"trueness_pct": 2.5, "cv_pct": 1.5}, "50ul": {"trueness_pct": 2.0, "cv_pct": 0.75}},
                "300ul_tip": {"10ul": {"trueness_pct": 5.0, "cv_pct": 2.0}, "50ul": {"trueness_pct": 2.0, "cv_pct": 0.75}, "200ul": {"trueness_pct": 1.0, "cv_pct": 0.75}},
                "1000ul_tip": {"10ul": {"trueness_pct": 7.5, "cv_pct": 3.5}, "100ul": {"trueness_pct": 2.0, "cv_pct": 0.75}, "1000ul": {"trueness_pct": 1.0, "cv_pct": 0.75}}
            }
        },
        "state_model": {
            "states": ["not_initialized", "idle", "tip_fitted", "aspirated", "moving", "error"],
            "transitions": [
                {"from": "not_initialized", "to": "idle", "trigger": "DI_complete"},
                {"from": "idle", "to": "tip_fitted", "trigger": "TP_complete"},
                {"from": "tip_fitted", "to": "aspirated", "trigger": "AS_complete"},
                {"from": "aspirated", "to": "tip_fitted", "trigger": "DS_complete"},
                {"from": "tip_fitted", "to": "idle", "trigger": "TR_complete"},
                {"from": "idle", "to": "moving", "trigger": "JY_or_JZ"},
                {"from": "tip_fitted", "to": "moving", "trigger": "JY_or_JZ"},
                {"from": "moving", "to": "idle", "trigger": "move_complete"},
                {"from": "moving", "to": "tip_fitted", "trigger": "move_complete_with_tip"},
                {"from": "*", "to": "error", "trigger": "error_detected"}
            ]
        },
        "commands": {
            "initialization": {
                "DI": {
                    "name": "Initialize Pipetting Channels",
                    "description": "Initialize PIP channels, discard any fitted tips. Must be called before any pipetting.",
                    "parameters": {
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position for tip discard"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel for tip discard"},
                        "tp": {"type": "int", "unit": "0.1mm", "description": "Z-start (begin of search)"},
                        "tz": {"type": "int", "unit": "0.1mm", "description": "Z-end position"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end deposit position"},
                        "tm": {"type": "int", "description": "Tip pattern bitmask (which channels participate)"},
                        "tt": {"type": "int", "range": [0, 99], "description": "Tip type index"},
                        "ti": {"type": "int", "description": "Discard method"}
                    },
                    "venus_step": "Run_Initialize",
                    "fw_code": "C0DI"
                }
            },
            "tip_handling": {
                "TP": {
                    "name": "Tip Pick-Up",
                    "description": "Pick up disposable tips from a tip rack using CO-RE technology",
                    "parameters": {
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position of tip rack"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "tm": {"type": "int", "description": "Tip pattern bitmask"},
                        "tt": {"type": "int", "range": [0, 99], "description": "Tip type index"},
                        "tp": {"type": "int", "unit": "0.1mm", "description": "Z-begin search height"},
                        "tz": {"type": "int", "unit": "0.1mm", "description": "Z-end height"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Minimum traverse height"},
                        "td": {"type": "int", "range": [0, 2], "description": "Pick up method: 0=auto, 1=from rack, 2=from wash station"}
                    },
                    "response": {
                        "sx": {"description": "Target squeeze height per channel"},
                        "sg": {"description": "Measured pickup height per channel"}
                    },
                    "venus_step": "Run_TipPickUp",
                    "fw_code": "C0TP"
                },
                "TR": {
                    "name": "Tip Discard",
                    "description": "Eject fitted tips at specified position",
                    "parameters": {
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "tp": {"type": "int", "unit": "0.1mm", "description": "Z-begin"},
                        "tz": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end deposit"},
                        "tm": {"type": "int", "description": "Tip pattern bitmask"},
                        "ti": {"type": "int", "description": "Discard method"}
                    },
                    "response": {
                        "kz": {"description": "Target O-ring squeeze per channel"},
                        "vz": {"description": "Measured squeeze per channel"}
                    },
                    "venus_step": "Run_TipEject",
                    "fw_code": "C0TR"
                },
                "TW": {
                    "name": "Tip Pick-Up for DC Wash",
                    "description": "Pick up tips specifically for DC wash procedure",
                    "parameters": {
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "tm": {"type": "int", "description": "Tip pattern"},
                        "tt": {"type": "int", "description": "Tip type index"},
                        "tp": {"type": "int", "unit": "0.1mm", "description": "Z-begin"},
                        "tz": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                        "ba": {"type": "int", "unit": "0.1ul", "description": "Blow-out volume"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"}
                    },
                    "fw_code": "C0TW"
                }
            },
            "liquid_handling": {
                "AS": {
                    "name": "Aspirate",
                    "description": "Aspiration of liquid using PIP channels. Supports multiple aspiration types, LLD modes, TADM monitoring, and mixing.",
                    "parameters": {
                        "at": {"type": "int", "range": [0, 2], "description": "Aspiration type: 0=simple, 1=sequence, 2=cup emptied"},
                        "tm": {"type": "int", "description": "Tip pattern bitmask"},
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Minimum traverse height"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end height"},
                        "lp": {"type": "int", "unit": "0.1mm", "description": "LLD search start height"},
                        "ch": {"type": "int", "unit": "0.1mm", "description": "Clot check height"},
                        "zl": {"type": "int_array", "unit": "0.1mm", "description": "Liquid surface height per channel"},
                        "po": {"type": "int", "unit": "0.1mm", "description": "Pull-out distance after aspiration"},
                        "zu": {"type": "int", "unit": "0.1mm", "description": "2nd section start height"},
                        "zr": {"type": "int", "description": "2nd section ratio"},
                        "zx": {"type": "int_array", "unit": "0.1mm", "description": "Minimum height (Z max) per channel"},
                        "ip": {"type": "int", "unit": "0.1mm", "description": "Immersion depth below liquid surface"},
                        "it": {"type": "int", "range": [0, 1], "description": "Immersion direction: 0=go deeper, 1=go higher"},
                        "fp": {"type": "int", "unit": "0.1mm", "description": "Surface following distance"},
                        "av": {"type": "int_array", "unit": "0.1ul", "description": "Aspiration volume per channel"},
                        "as": {"type": "int", "unit": "0.1ul/s", "description": "Aspiration speed"},
                        "ta": {"type": "int", "unit": "0.1ul", "description": "Transport air volume"},
                        "ba": {"type": "int", "unit": "0.1ul", "description": "Blow-out air volume"},
                        "oa": {"type": "int", "unit": "0.1ul", "description": "Pre-wetting volume"},
                        "lm": {"type": "int", "range": [0, 4], "description": "LLD mode: 0=off, 1=cLLD, 2=pLLD, 3=dual, 4=Z-touch"},
                        "ll": {"type": "int", "description": "cLLD sensitivity (1=high, 4=low)"},
                        "lv": {"type": "int", "description": "pLLD sensitivity"},
                        "zo": {"type": "int", "unit": "0.1mm", "description": "Z-touch offset"},
                        "ld": {"type": "int", "unit": "0.1mm", "description": "Dual LLD difference"},
                        "de": {"type": "int", "unit": "0.1mm/s", "description": "Swap speed (Z-movement speed during LLD)"},
                        "wt": {"type": "int", "unit": "0.1s", "description": "Settling time after positioning"},
                        "mv": {"type": "int", "unit": "0.1ul", "description": "Mixing volume"},
                        "mc": {"type": "int", "description": "Mixing cycles"},
                        "mp": {"type": "int", "unit": "0.1mm", "description": "Mixing position offset"},
                        "ms": {"type": "int", "unit": "0.1ul/s", "description": "Mixing speed"},
                        "mh": {"type": "int", "unit": "0.1mm", "description": "Mixing height"},
                        "gi": {"type": "int", "description": "TADM channel pattern"},
                        "gj": {"type": "int", "description": "TADM upper tolerance band"},
                        "gk": {"type": "int", "description": "TADM lower tolerance band"}
                    },
                    "response": {
                        "er": {"description": "Error code per channel"},
                        "lz": {"description": "Detected liquid level per channel (if LLD used)"}
                    },
                    "venus_step": "Run_Aspirate",
                    "venus_source": "CRunAspirate -> McAspirate -> AtsMcAspirate",
                    "fw_code": "C0AS"
                },
                "DS": {
                    "name": "Dispense",
                    "description": "Dispensing of liquid using PIP channels. Supports multiple dispense modes, LLD, TADM, and mixing.",
                    "parameters": {
                        "dm": {"type": "int", "range": [0, 4], "description": "Dispense mode: 0=partial jet, 1=blow-out jet, 2=partial surface, 3=blow-out surface, 4=empty tip"},
                        "tm": {"type": "int", "description": "Tip pattern bitmask"},
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "zx": {"type": "int_array", "unit": "0.1mm", "description": "Minimum height per channel"},
                        "lp": {"type": "int", "unit": "0.1mm", "description": "LLD search start height"},
                        "zl": {"type": "int_array", "unit": "0.1mm", "description": "Liquid surface height per channel"},
                        "po": {"type": "int", "unit": "0.1mm", "description": "Pull-out distance"},
                        "ip": {"type": "int", "unit": "0.1mm", "description": "Immersion depth"},
                        "it": {"type": "int", "range": [0, 1], "description": "Immersion direction"},
                        "fp": {"type": "int", "unit": "0.1mm", "description": "Surface following distance"},
                        "zu": {"type": "int", "unit": "0.1mm", "description": "2nd section height"},
                        "zr": {"type": "int", "description": "2nd section ratio"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end height"},
                        "dv": {"type": "int_array", "unit": "0.1ul", "description": "Dispense volume per channel"},
                        "ds": {"type": "int", "unit": "0.1ul/s", "description": "Dispense speed"},
                        "ss": {"type": "int", "unit": "0.1ul/s", "description": "Cut-off speed"},
                        "rv": {"type": "int", "unit": "0.1ul", "description": "Stop-back volume"},
                        "ta": {"type": "int", "unit": "0.1ul", "description": "Transport air volume"},
                        "ba": {"type": "int", "unit": "0.1ul", "description": "Blow-out volume"},
                        "lm": {"type": "int", "range": [0, 4], "description": "LLD mode"},
                        "dj": {"type": "int", "range": [0, 1], "description": "Side touch-off: 0=off, 1=on"},
                        "zo": {"type": "int", "unit": "0.1mm", "description": "Z-touch offset"},
                        "ll": {"type": "int", "description": "cLLD sensitivity"},
                        "lv": {"type": "int", "description": "pLLD sensitivity"},
                        "de": {"type": "int", "unit": "0.1mm/s", "description": "Swap speed"},
                        "wt": {"type": "int", "unit": "0.1s", "description": "Settling time"},
                        "mv": {"type": "int", "unit": "0.1ul", "description": "Mixing volume"},
                        "mc": {"type": "int", "description": "Mixing cycles"},
                        "mp": {"type": "int", "unit": "0.1mm", "description": "Mixing position"},
                        "ms": {"type": "int", "unit": "0.1ul/s", "description": "Mixing speed"},
                        "mh": {"type": "int", "unit": "0.1mm", "description": "Mixing height"},
                        "gi": {"type": "int", "description": "TADM channel pattern"},
                        "gj": {"type": "int", "description": "TADM upper tolerance"},
                        "gk": {"type": "int", "description": "TADM lower tolerance"}
                    },
                    "venus_step": "Run_Dispense",
                    "venus_source": "CRunDispense -> McDispense -> AtsMcDispense",
                    "fw_code": "C0DS"
                },
                "DA": {
                    "name": "Simultaneous Aspirate and Dispense",
                    "description": "Combined aspiration and dispensation in one command. Some channels aspirate while others dispense.",
                    "parameters": {
                        "dd": {"type": "int", "description": "Asp/disp pattern per channel (bitmask: which channels aspirate vs dispense)"},
                        "_note": "All AS + DS parameters apply per the pattern"
                    },
                    "fw_code": "C0DA"
                },
                "DF": {
                    "name": "Dispense on Fly",
                    "description": "Dispense while X-arm is moving (partial jet mode). For high-throughput dispensing across multiple positions.",
                    "parameters": {
                        "tm": {"type": "int", "description": "Tip pattern"},
                        "xs": {"type": "int", "unit": "0.1mm", "description": "First shoot X-position"},
                        "xf": {"type": "int", "range": [0, 1], "description": "Direction: 0=left-to-right, 1=right-to-left"},
                        "en": {"type": "int", "unit": "0.1mm", "description": "End X-position"},
                        "xh": {"type": "int", "unit": "0.1mm", "description": "Acceleration distance"},
                        "xy": {"type": "int", "unit": "0.1mm", "description": "Raster pitch between shoots"},
                        "xz": {"type": "int", "unit": "0.1mm/s", "description": "X-travel speed"},
                        "xi": {"type": "int", "description": "Number of shoots"},
                        "xj": {"type": "int", "description": "Shoot pattern per channel"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end height"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "zl": {"type": "int_array", "unit": "0.1mm", "description": "Z dispense height per channel"},
                        "dv": {"type": "int_array", "unit": "0.1ul", "description": "Volume per shoot per channel"},
                        "ds": {"type": "int", "unit": "0.1ul/s", "description": "Dispense speed"},
                        "ss": {"type": "int", "unit": "0.1ul/s", "description": "Cut-off speed"},
                        "rv": {"type": "int", "unit": "0.1ul", "description": "Stop-back volume"},
                        "ta": {"type": "int", "unit": "0.1ul", "description": "Transport air"},
                        "gi": {"type": "int", "description": "TADM channel pattern"},
                        "gj": {"type": "int", "description": "TADM upper tolerance"},
                        "gk": {"type": "int", "description": "TADM lower tolerance"}
                    },
                    "venus_step": "Run_DispenseFly",
                    "fw_code": "C0DF"
                },
                "DC": {
                    "name": "Set Multi-Dispense Values",
                    "description": "Configure parameters for multi-dispense (aliquoting) operations",
                    "parameters": {
                        "dc": {"type": "int", "range": [0, 99], "description": "Number of dispense cycles"},
                        "dx": {"type": "int", "unit": "0.1mm", "description": "X-offset between dispense positions"}
                    },
                    "fw_code": "C0DC"
                }
            },
            "wash": {
                "LW": {
                    "name": "DC Wash Procedure",
                    "description": "Perform dual-chamber wash using PIP channels (aspirate wash liquid, dispense waste)",
                    "parameters": {
                        "tm": {"type": "int", "description": "Tip pattern"},
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                        "zl": {"type": "int_array", "unit": "0.1mm", "description": "Wash position (Z)"},
                        "av": {"type": "int", "unit": "0.1ul", "description": "Wash volume"},
                        "as": {"type": "int", "unit": "0.1ul/s", "description": "Aspiration speed"},
                        "ds": {"type": "int", "unit": "0.1ul/s", "description": "Dispense speed"},
                        "de": {"type": "int", "unit": "0.1mm/s", "description": "Swap speed"},
                        "sa": {"type": "int", "unit": "0.1s", "description": "Soak time"},
                        "dc": {"type": "int", "description": "Wash cycles"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end position"}
                    },
                    "fw_code": "C0LW"
                }
            },
            "movement": {
                "JY": {
                    "name": "Position All PIP Channels Y",
                    "description": "Move all PIP channels to specified Y positions simultaneously",
                    "parameters": {"yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"}},
                    "fw_code": "C0JY"
                },
                "JZ": {
                    "name": "Position All PIP Channels Z",
                    "description": "Move all PIP channels to specified Z positions simultaneously",
                    "parameters": {"zp": {"type": "int_array", "unit": "0.1mm", "description": "Z-position per channel"}},
                    "fw_code": "C0JZ"
                },
                "KY": {
                    "name": "Position Single PIP Channel Y",
                    "description": "Move one PIP channel to Y position",
                    "parameters": {
                        "pn": {"type": "int", "description": "Channel index (0-based)"},
                        "yj": {"type": "int", "unit": "0.1mm", "description": "Target Y-position"}
                    },
                    "fw_code": "C0KY"
                },
                "KZ": {
                    "name": "Position Single PIP Channel Z",
                    "description": "Move one PIP channel to Z position",
                    "parameters": {
                        "pn": {"type": "int", "description": "Channel index"},
                        "zj": {"type": "int", "unit": "0.1mm", "description": "Target Z-position"}
                    },
                    "fw_code": "C0KZ"
                },
                "JM": {
                    "name": "Move All PIP to Position",
                    "description": "Move all PIP channels to defined X/Y/Z positions with traverse height",
                    "parameters": {
                        "tm": {"type": "int", "description": "Tip pattern"},
                        "xp": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yp": {"type": "int_array", "unit": "0.1mm", "description": "Y-position per channel"},
                        "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                        "zp": {"type": "int_array", "unit": "0.1mm", "description": "Z-position per channel"}
                    },
                    "venus_step": "Run_MoveToPosition",
                    "fw_code": "C0JM"
                },
                "JP": {
                    "name": "Free Y Range for Channel",
                    "description": "Position all PIP channels to maximize free Y range for channel n",
                    "parameters": {"pn": {"type": "int", "description": "Channel index to free range for"}},
                    "fw_code": "C0JP"
                },
                "JE": {
                    "name": "Spread PIP Channels",
                    "description": "Spread channels to specified spacing pattern",
                    "parameters": {},
                    "fw_code": "C0JE"
                },
                "ZA": {
                    "name": "Move All PIP to Z-Safety",
                    "description": "Raise all PIP channels to safe Z height",
                    "parameters": {},
                    "fw_code": "C0ZA"
                },
                "XL": {
                    "name": "Search Teach-In Signal",
                    "description": "Search for teach-in signal using PIP channel n in X direction",
                    "parameters": {
                        "pn": {"type": "int", "description": "Channel index"},
                        "xs": {"type": "int", "unit": "0.1mm", "description": "X search target"}
                    },
                    "fw_code": "C0XL"
                },
                "JR": {
                    "name": "Teach Rack",
                    "description": "Teach rack position using PIP channel n",
                    "parameters": {
                        "pn": {"type": "int", "description": "Channel index"},
                        "xs": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                        "yj": {"type": "int", "unit": "0.1mm", "description": "Y-position"},
                        "zj": {"type": "int", "unit": "0.1mm", "description": "Z-position"},
                        "te": {"type": "int", "unit": "0.1mm", "description": "Z-end"}
                    },
                    "response": {
                        "rx": {"description": "Measured X of gap center"},
                        "rb": {"description": "Measured Y of gap center"},
                        "rd": {"description": "Measured Z of gap center"}
                    },
                    "fw_code": "C0JR"
                }
            },
            "queries": {
                "RY": {"name": "Request All PIP Y-Positions", "parameters": {}, "response": {"ry": "Y per channel"}, "fw_code": "C0RY"},
                "RB": {"name": "Request Single PIP Y-Position", "parameters": {"pn": {"type": "int"}}, "response": {"rb": "Y position"}, "fw_code": "C0RB"},
                "RZ": {"name": "Request All PIP Z-Positions", "parameters": {}, "response": {"rz": "Z per channel"}, "fw_code": "C0RZ"},
                "RD": {"name": "Request Single PIP Z-Position", "parameters": {"pn": {"type": "int"}}, "response": {"rd": "Z position"}, "fw_code": "C0RD"},
                "RT": {"name": "Query Tip Presence", "parameters": {}, "response": {"rt": "tip_state_per_channel"}, "fw_code": "C0RT"},
                "RL": {"name": "Request Last LLD Height", "parameters": {}, "response": {"rl": "height_per_channel"}, "fw_code": "C0RL"},
                "QS": {"name": "Request TADM Status", "parameters": {}, "response": {"qs": "tadm_status"}, "fw_code": "C0QS"},
                "FS": {"name": "Request Dispense-on-Fly Status", "parameters": {}, "response": {"fs": "fly_status"}, "fw_code": "C0FS"},
                "VE": {"name": "Request 2nd Section Asp Data", "parameters": {}, "response": {"ve": "section_data"}, "fw_code": "C0VE"}
            }
        }
    }

    # -------------------------------------------------------------------------
    # CO-RE 96 HEAD
    # -------------------------------------------------------------------------
    spec["modules"]["core96_head"] = {
        "name": "CO-RE 96 Multi-Probe Head",
        "fw_prefix": "C0 (operational) / H0 (diagnostics)",
        "doc_ref": "E2891001a.docx (Master), E289018a.doc, E2891003a.doc (96 Head II/TADM)",
        "description": (
            "96-channel parallel pipetting head in 8x12 SBS format. Moves as a single unit "
            "in X, Y, Z. Supports cLLD on A1 and H12 positions. TADM version available."
        ),
        "hardware": {
            "channels": 96,
            "format": "8x12 (SBS/ANSI/SLAS)",
            "channel_volume_ul": 1000,
            "tip_sizes_ul": [10, 50, 300, 1000],
            "cLLD_positions": ["A1", "H12"],
            "tadm_variant": True,
            "y_range_0_1mm": [1054, 5743],
            "pipetting_specs": {
                "300ul_tip": {"10ul": {"trueness_pct": 3.0, "cv_pct": 2.0}, "50ul": {"trueness_pct": 1.5, "cv_pct": 1.0}, "300ul": {"trueness_pct": 1.0, "cv_pct": 1.0}},
                "1000ul_tip": {"10ul": {"trueness_pct": 7.5, "cv_pct": 3.5}, "100ul": {"trueness_pct": 2.0, "cv_pct": 1.0}, "1000ul": {"trueness_pct": 1.0, "cv_pct": 1.0}}
            }
        },
        "state_model": {
            "states": ["not_initialized", "idle", "tips_fitted", "aspirated", "moving", "error"],
            "transitions": [
                {"from": "not_initialized", "to": "idle", "trigger": "EI_complete"},
                {"from": "idle", "to": "tips_fitted", "trigger": "EP_complete"},
                {"from": "tips_fitted", "to": "aspirated", "trigger": "EA_complete"},
                {"from": "aspirated", "to": "tips_fitted", "trigger": "ED_complete"},
                {"from": "tips_fitted", "to": "idle", "trigger": "ER_complete"},
                {"from": "*", "to": "error", "trigger": "error_detected"}
            ]
        },
        "commands": {
            "EI": {
                "name": "Initialize CoRe 96 Head",
                "description": "Initialize the 96-channel head, move to home position",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position of A1 well"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction: 0=positive, 1=negative"},
                    "yh": {"type": "int", "range": [1054, 5743], "unit": "0.1mm", "description": "Y-position of A1"},
                    "za": {"type": "int", "unit": "0.1mm", "description": "Z-deposit height"},
                    "ze": {"type": "int", "unit": "0.1mm", "description": "Z-end position"}
                },
                "venus_step": "Run_Head96TipPickUp (init phase)",
                "fw_code": "C0EI"
            },
            "EV": {"name": "Move 96 Head to Z-Safe", "description": "Raise 96-head to safe height", "parameters": {}, "fw_code": "C0EV"},
            "EP": {
                "name": "CoRe 96 Tip Pick-Up",
                "description": "Pick up 96 tips simultaneously from a tip rack or wash station",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position A1"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yh": {"type": "int", "range": [1080, 5600], "unit": "0.1mm", "description": "Y-position A1"},
                    "tt": {"type": "int", "range": [0, 99], "description": "Tip type index"},
                    "wu": {"type": "int", "range": [0, 3], "description": "Method: 0=rack, 1=wash station, 2=full blowout, 3=partial blowout"},
                    "za": {"type": "int", "unit": "0.1mm", "description": "Z-deposit height"},
                    "zh": {"type": "int", "unit": "0.1mm", "description": "Z traverse height"},
                    "ze": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                    "bv": {"type": "int", "unit": "0.1ul", "description": "Blow-out volume (for wash station methods)"}
                },
                "venus_step": "Run_Head96TipPickUp",
                "fw_code": "C0EP"
            },
            "ER": {
                "name": "CoRe 96 Tip Discard",
                "description": "Eject all 96 tips",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position A1"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yh": {"type": "int", "unit": "0.1mm", "description": "Y-position A1"},
                    "za": {"type": "int", "unit": "0.1mm", "description": "Z-deposit"},
                    "zh": {"type": "int", "unit": "0.1mm", "description": "Z traverse"},
                    "ze": {"type": "int", "unit": "0.1mm", "description": "Z-end"}
                },
                "venus_step": "Run_Head96TipEject",
                "fw_code": "C0ER"
            },
            "EA": {
                "name": "Aspirate CoRe 96 Head",
                "description": "Aspirate liquid with all 96 channels simultaneously",
                "parameters": {
                    "aa": {"type": "int", "range": [0, 2], "description": "Aspiration type: 0=simple, 1=sequence, 2=cup emptied"},
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position A1"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yh": {"type": "int", "unit": "0.1mm", "description": "Y-position A1"},
                    "zh": {"type": "int", "unit": "0.1mm", "description": "Z traverse height"},
                    "ze": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                    "lz": {"type": "int", "unit": "0.1mm", "description": "LLD search start height"},
                    "zt": {"type": "int", "unit": "0.1mm", "description": "Liquid surface at start"},
                    "pp": {"type": "int", "unit": "0.1mm", "description": "Pull-out distance"},
                    "zm": {"type": "int", "unit": "0.1mm", "description": "Minimum height"},
                    "zv": {"type": "int", "unit": "0.1mm", "description": "2nd section height"},
                    "zq": {"type": "int", "description": "2nd section ratio"},
                    "iw": {"type": "int", "unit": "0.1mm", "description": "Immersion depth"},
                    "ix": {"type": "int", "range": [0, 1], "description": "Immersion direction"},
                    "fh": {"type": "int", "unit": "0.1mm", "description": "Surface following (sink distance)"},
                    "af": {"type": "int", "unit": "0.1ul", "description": "Aspiration volume"},
                    "ag": {"type": "int", "unit": "0.1ul/s", "description": "Aspiration speed"},
                    "vt": {"type": "int", "unit": "0.1ul", "description": "Transport air"},
                    "bv": {"type": "int", "unit": "0.1ul", "description": "Blow-out air"},
                    "wv": {"type": "int", "unit": "0.1ul", "description": "Pre-wetting volume"},
                    "cm": {"type": "int", "range": [0, 1], "description": "cLLD mode: 0=off, 1=on"},
                    "cs": {"type": "int", "description": "cLLD sensitivity"},
                    "bs": {"type": "int", "unit": "0.1mm/s", "description": "Swap speed"},
                    "wh": {"type": "int", "unit": "0.1s", "description": "Settling time"},
                    "hv": {"type": "int", "unit": "0.1ul", "description": "Mixing volume"},
                    "hc": {"type": "int", "description": "Mixing cycles"},
                    "hp": {"type": "int", "unit": "0.1mm", "description": "Mixing position"},
                    "mj": {"type": "int", "unit": "0.1ul/s", "description": "Mixing speed"},
                    "hs": {"type": "int", "unit": "0.1mm", "description": "Mixing height"},
                    "cr": {"type": "int", "description": "TADM channel pattern"},
                    "cj": {"type": "int", "description": "TADM upper tolerance"},
                    "cx": {"type": "int", "description": "TADM lower tolerance"}
                },
                "venus_step": "Run_Head96Aspirate",
                "venus_source": "CRun96HeadAspirate -> Mc96HeadAspirate -> AtsMc96HeadAspirate",
                "fw_code": "C0EA"
            },
            "ED": {
                "name": "Dispense CoRe 96 Head",
                "description": "Dispense liquid with all 96 channels simultaneously",
                "parameters": {
                    "da": {"type": "int", "range": [0, 4], "description": "Dispense mode: 0=partial jet, 1=blow-out jet, 2=partial surface, 3=blow-out surface, 4=empty tip"},
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position A1"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yh": {"type": "int", "unit": "0.1mm", "description": "Y-position A1"},
                    "zm": {"type": "int", "unit": "0.1mm", "description": "Minimum height"},
                    "zv": {"type": "int", "unit": "0.1mm", "description": "2nd section height"},
                    "zq": {"type": "int", "description": "2nd section ratio"},
                    "lz": {"type": "int", "unit": "0.1mm", "description": "LLD search height"},
                    "zt": {"type": "int", "unit": "0.1mm", "description": "Liquid surface"},
                    "pp": {"type": "int", "unit": "0.1mm", "description": "Pull-out distance"},
                    "iw": {"type": "int", "unit": "0.1mm", "description": "Immersion depth"},
                    "ix": {"type": "int", "range": [0, 1], "description": "Immersion direction"},
                    "fh": {"type": "int", "unit": "0.1mm", "description": "Surface following"},
                    "zh": {"type": "int", "unit": "0.1mm", "description": "Z traverse"},
                    "ze": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                    "df": {"type": "int", "unit": "0.1ul", "description": "Dispense volume"},
                    "dg": {"type": "int", "unit": "0.1ul/s", "description": "Dispense speed"},
                    "es": {"type": "int", "unit": "0.1ul/s", "description": "Cut-off speed"},
                    "ev": {"type": "int", "unit": "0.1ul", "description": "Stop-back volume"},
                    "vt": {"type": "int", "unit": "0.1ul", "description": "Transport air"},
                    "bv": {"type": "int", "unit": "0.1ul", "description": "Blow-out volume"},
                    "cm": {"type": "int", "range": [0, 1], "description": "cLLD mode"},
                    "cs": {"type": "int", "description": "cLLD sensitivity"},
                    "ej": {"type": "int", "range": [0, 1], "description": "Side touch-off"},
                    "bs": {"type": "int", "unit": "0.1mm/s", "description": "Swap speed"},
                    "wh": {"type": "int", "unit": "0.1s", "description": "Settling time"},
                    "hv": {"type": "int", "unit": "0.1ul", "description": "Mixing volume"},
                    "hc": {"type": "int", "description": "Mixing cycles"},
                    "hp": {"type": "int", "unit": "0.1mm", "description": "Mixing position"},
                    "mj": {"type": "int", "unit": "0.1ul/s", "description": "Mixing speed"},
                    "hs": {"type": "int", "unit": "0.1mm", "description": "Mixing height"},
                    "cr": {"type": "int", "description": "TADM channel pattern"},
                    "cj": {"type": "int", "description": "TADM upper tolerance"},
                    "cx": {"type": "int", "description": "TADM lower tolerance"}
                },
                "venus_step": "Run_Head96Dispense",
                "fw_code": "C0ED"
            },
            "EM": {
                "name": "Move 96 Head to Position",
                "description": "Move the 96-head to an absolute position",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position A1"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yh": {"type": "int", "unit": "0.1mm", "description": "Y-position A1"},
                    "za": {"type": "int", "unit": "0.1mm", "description": "Z target position"},
                    "zh": {"type": "int", "unit": "0.1mm", "description": "Z traverse height"}
                },
                "venus_step": "Run_Head96Move",
                "fw_code": "C0EM"
            },
            "EG": {
                "name": "Wash Tips CoRe 96",
                "description": "Wash 96 tips in wash station",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position A1"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yh": {"type": "int", "unit": "0.1mm", "description": "Y-position A1"},
                    "zt": {"type": "int", "unit": "0.1mm", "description": "Wash Z position"},
                    "zm": {"type": "int", "unit": "0.1mm", "description": "Min height"},
                    "fh": {"type": "int", "unit": "0.1mm", "description": "Surface following"},
                    "zh": {"type": "int", "unit": "0.1mm", "description": "Z traverse"},
                    "hv": {"type": "int", "unit": "0.1ul", "description": "Wash volume"},
                    "hc": {"type": "int", "description": "Wash cycles"},
                    "hs": {"type": "int", "unit": "0.1ul/s", "description": "Wash speed"}
                },
                "venus_step": "Run_Head96Wash",
                "fw_code": "C0EG"
            },
            "EU": {
                "name": "Empty Washed Tips 96",
                "description": "Empty washed tips after wash procedure",
                "parameters": {
                    "zt": {"type": "int", "unit": "0.1mm", "description": "Z position"},
                    "ze": {"type": "int", "unit": "0.1mm", "description": "Z-end"}
                },
                "venus_step": "Run_Head96EmptyWasher",
                "fw_code": "C0EU"
            },
            "QH": {"name": "Request Tip Presence 96", "parameters": {}, "response": {"qh": "tip_state"}, "fw_code": "C0QH"},
            "QI": {"name": "Request 96 Head Position", "parameters": {}, "response": {"qi": "position_with_tip_length"}, "fw_code": "C0QI"},
            "VC": {"name": "Request 96 TADM Status", "parameters": {}, "response": {"vc": "tadm_status"}, "fw_code": "C0VC"},
            "VB": {"name": "Request 96 TADM Error Status", "parameters": {}, "response": {"vb": "tadm_error"}, "fw_code": "C0VB"}
        }
    }

    # -------------------------------------------------------------------------
    # AUTOLOAD
    # -------------------------------------------------------------------------
    spec["modules"]["autoload"] = {
        "name": "AutoLoad System",
        "fw_prefix": "C0 (via master)",
        "doc_ref": "E2891001a.docx (Master), E289004a.doc, E2891024a.docx (2D)",
        "description": (
            "Automatic carrier loading system with barcode reading. Loads carriers from "
            "the loading tray onto the deck, reads carrier and labware barcodes, and "
            "supports both 1D and 2D barcode types."
        ),
        "state_model": {
            "states": ["not_initialized", "idle", "loading", "unloading", "identifying", "error"],
            "transitions": [
                {"from": "not_initialized", "to": "idle", "trigger": "II_complete"},
                {"from": "idle", "to": "loading", "trigger": "CL_command"},
                {"from": "loading", "to": "idle", "trigger": "CL_complete"},
                {"from": "idle", "to": "unloading", "trigger": "CR_command"},
                {"from": "unloading", "to": "idle", "trigger": "CR_complete"},
                {"from": "idle", "to": "identifying", "trigger": "CI_command"},
                {"from": "identifying", "to": "idle", "trigger": "CI_complete"}
            ]
        },
        "commands": {
            "II": {"name": "Initialize AutoLoad", "description": "Initialize the autoload system", "parameters": {}, "venus_step": "Run_InitAutoLoad", "fw_code": "C0II"},
            "IV": {"name": "Move AutoLoad to Z-Safe", "description": "Raise autoload to safe position", "parameters": {}, "fw_code": "C0IV"},
            "CI": {
                "name": "Identify Carrier",
                "description": "Determine carrier type at a loading position by reading its barcode",
                "parameters": {},
                "response": {"carrier_type": "identified_type", "barcode": "carrier_barcode"},
                "fw_code": "C0CI"
            },
            "CT": {"name": "Check Carrier Presence", "description": "Check if a carrier is present at a specific position", "parameters": {}, "response": {"ct": "0=absent|1=present"}, "fw_code": "C0CT"},
            "CL": {
                "name": "Load Carrier",
                "description": "Load carrier from tray onto deck, reading all barcodes during loading",
                "parameters": {
                    "cb": {"type": "string", "description": "Barcode type configuration"},
                    "mo": {"type": "string", "description": "Reader illumination/gain/exposure settings (2D only)"},
                    "ma": {"type": "string", "description": "ROI parameters (2D only)"}
                },
                "response": {"barcodes": "all_read_barcodes"},
                "venus_step": "Run_LoadCarrier",
                "fw_code": "C0CL"
            },
            "CR": {"name": "Unload Carrier", "description": "Unload carrier from deck to tray", "parameters": {}, "venus_step": "Run_UnloadCarrier", "fw_code": "C0CR"},
            "CW": {"name": "Unload Carrier Finally", "description": "Unload carrier completely to loading tray", "parameters": {}, "fw_code": "C0CW"},
            "CA": {"name": "Push Carrier to Tray", "description": "Push carrier from deck to loading tray position", "parameters": {}, "fw_code": "C0CA"},
            "CN": {"name": "Move to Identification Position", "description": "Move carrier to barcode reading position", "parameters": {}, "fw_code": "C0CN"},
            "CP": {
                "name": "Set Loading Indicators",
                "description": "Control LED indicators on loading tray to guide operator",
                "parameters": {"cp": {"type": "string", "description": "LED pattern per track"}},
                "fw_code": "C0CP"
            },
            "CS": {"name": "Check Carriers on Tray", "description": "Check which loading tray positions have carriers", "parameters": {}, "response": {"cs": "presence_per_position"}, "fw_code": "C0CS"},
            "CB": {
                "name": "Set Barcode Types",
                "description": "Configure which barcode symbologies to recognize",
                "parameters": {"cb": {"type": "string", "description": "Barcode type configuration"}},
                "fw_code": "C0CB"
            },
            "CU": {"name": "Set Carrier Monitoring", "description": "Enable/disable carrier presence monitoring", "parameters": {}, "fw_code": "C0CU"},
            "DB": {"name": "Set Free-Definable Carrier Reading", "description": "Configure barcode reading for custom carriers", "parameters": {}, "fw_code": "C0DB"},
            "DR": {"name": "Reset Free-Definable Settings", "description": "Reset custom carrier configuration", "parameters": {}, "fw_code": "C0DR"},
            "RC": {"name": "Query Carrier on Deck", "description": "Check carrier presence on deck", "parameters": {}, "response": {"rc": "carrier_present"}, "fw_code": "C0RC"},
            "QA": {"name": "Request AutoLoad Slot Position", "description": "Returns autoload position data", "parameters": {}, "response": {"qa": "position_data"}, "fw_code": "C0QA"},
            "CQ": {"name": "Request AutoLoad Module Type", "description": "Returns autoload variant", "parameters": {}, "response": {"cq": "module_type"}, "fw_code": "C0CQ"},
            "VL": {"name": "Request Code Data Length", "description": "Returns length of read labware barcodes", "parameters": {}, "response": {"vl": "lengths"}, "fw_code": "C0VL"}
        }
    }

    # -------------------------------------------------------------------------
    # iSWAP
    # -------------------------------------------------------------------------
    spec["modules"]["iswap"] = {
        "name": "iSWAP (Internal Swivel Arm Plate handler)",
        "fw_prefix": "C0 (via master) / R0 (diagnostics)",
        "doc_ref": "E2891001a.docx (Master), E289015a.doc (iSWAP 4 generations)",
        "description": (
            "Robotic arm mounted on the pipetting arm for plate transport. Can pick up, "
            "rotate, and place ANSI/SLAS format plates to any deck position. 4 generations "
            "documented. Supports landscape and portrait orientations with rotation."
        ),
        "hardware": {
            "plate_height_mm": [5, 43],
            "position_accuracy_mm": 0.5,
            "grip_force_n": [5, 16],
            "default_grip_force_n": 9,
            "max_transport_mass_g": 300,
            "max_per_instrument": 1
        },
        "state_model": {
            "states": ["not_initialized", "parked", "empty", "plate_gripped", "moving", "error"],
            "transitions": [
                {"from": "not_initialized", "to": "parked", "trigger": "FI_complete"},
                {"from": "parked", "to": "empty", "trigger": "unpark"},
                {"from": "empty", "to": "plate_gripped", "trigger": "PP_complete"},
                {"from": "plate_gripped", "to": "empty", "trigger": "PR_complete"},
                {"from": "plate_gripped", "to": "moving", "trigger": "PM_command"},
                {"from": "moving", "to": "plate_gripped", "trigger": "PM_complete"},
                {"from": "empty", "to": "parked", "trigger": "PG_complete"},
                {"from": "*", "to": "error", "trigger": "error_detected"}
            ]
        },
        "commands": {
            "FI": {"name": "Initialize iSWAP", "description": "Initialize the iSWAP arm and drives", "parameters": {}, "venus_step": "Run_InitISwap", "fw_code": "C0FI"},
            "FY": {"name": "Free Y Range for iSWAP", "description": "Clear Y axis space for iSWAP movement", "parameters": {}, "fw_code": "C0FY"},
            "GX": {"name": "Move iSWAP X", "description": "Move iSWAP in X direction", "parameters": {"gx": {"type": "int", "unit": "0.1mm"}}, "fw_code": "C0GX"},
            "GY": {"name": "Move iSWAP Y", "description": "Move iSWAP in Y direction", "parameters": {"gy": {"type": "int", "unit": "0.1mm"}}, "fw_code": "C0GY"},
            "GZ": {"name": "Move iSWAP Z", "description": "Move iSWAP in Z direction", "parameters": {"gz": {"type": "int", "unit": "0.1mm"}}, "fw_code": "C0GZ"},
            "GI": {"name": "Open Gripper Not-Initialized", "description": "Open iSWAP gripper without init check (recovery)", "parameters": {}, "fw_code": "C0GI"},
            "GF": {"name": "Open Gripper", "description": "Open the iSWAP gripper jaws", "parameters": {}, "fw_code": "C0GF"},
            "GC": {"name": "Close Gripper", "description": "Close the iSWAP gripper jaws", "parameters": {}, "fw_code": "C0GC"},
            "PG": {"name": "Park iSWAP", "description": "Move iSWAP to park position", "parameters": {}, "venus_step": "Run_ISwapPark", "fw_code": "C0PG"},
            "PP": {
                "name": "Get Plate (iSWAP)",
                "description": "Pick up a plate from a deck position using iSWAP",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yj": {"type": "int", "unit": "0.1mm", "description": "Y grip position"},
                    "yd": {"type": "int", "range": [0, 1], "description": "Y approach direction"},
                    "zj": {"type": "int", "unit": "0.1mm", "description": "Z grip height"},
                    "zy": {"type": "int", "unit": "0.1mm/s", "description": "Z speed"},
                    "yo": {"type": "int", "unit": "0.1mm", "description": "Gripper open position"},
                    "yg": {"type": "int", "unit": "0.1mm", "description": "Plate grip width"},
                    "yw": {"type": "int", "description": "Grip strength (force)"},
                    "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                    "te": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                    "gr": {"type": "int", "range": [0, 1], "description": "Grip direction: 0=landscape, 1=portrait"}
                },
                "venus_step": "Run_GetPlate",
                "venus_source": "CRunGetPlate -> McGetPlate -> AtsMcGetPlate",
                "fw_code": "C0PP"
            },
            "PR": {
                "name": "Put Plate (iSWAP)",
                "description": "Place a plate at a deck position using iSWAP",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yj": {"type": "int", "unit": "0.1mm", "description": "Y position"},
                    "zj": {"type": "int", "unit": "0.1mm", "description": "Z deposit height"},
                    "zi": {"type": "int", "unit": "0.1mm", "description": "Z press-on distance"},
                    "zy": {"type": "int", "unit": "0.1mm/s", "description": "Z speed"},
                    "yo": {"type": "int", "unit": "0.1mm", "description": "Gripper open position"},
                    "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                    "te": {"type": "int", "unit": "0.1mm", "description": "Z-end"}
                },
                "venus_step": "Run_PutPlate",
                "fw_code": "C0PR"
            },
            "PM": {
                "name": "Move Plate to Position",
                "description": "Move gripped plate to a new position (without releasing)",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X target"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yj": {"type": "int", "unit": "0.1mm", "description": "Y target"},
                    "zj": {"type": "int", "unit": "0.1mm", "description": "Z target"},
                    "zy": {"type": "int", "unit": "0.1mm/s", "description": "Z speed"},
                    "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"}
                },
                "venus_step": "Run_MovePlate",
                "fw_code": "C0PM"
            },
            "PN": {"name": "Collapse Gripper Arm", "description": "Collapse iSWAP arm to compact position", "parameters": {}, "fw_code": "C0PN"},
            "PO": {"name": "Get Plate from Hotel", "description": "Pick up plate from stacking hotel", "parameters": {}, "fw_code": "C0PO"},
            "PI": {"name": "Put Plate to Hotel", "description": "Place plate into stacking hotel", "parameters": {}, "fw_code": "C0PI"},
            "PB": {
                "name": "Read Barcode (iSWAP)",
                "description": "Read barcode of plate held by iSWAP or at deck position",
                "parameters": {
                    "cp": {"type": "int", "description": "Slot number"},
                    "zb": {"type": "int", "unit": "0.1mm", "description": "Minimum Z for reading"},
                    "zy": {"type": "int", "unit": "0.1mm/s", "description": "Z speed"},
                    "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                    "ma": {"type": "string", "description": "ROI parameters"},
                    "mr": {"type": "int", "description": "ROI direction"},
                    "bd": {"type": "int", "description": "Barcode direction"},
                    "mo": {"type": "int", "description": "Illumination mode"}
                },
                "response": {"bb": "barcode_data"},
                "venus_step": "Run_ReadPlateBarcode",
                "fw_code": "C0PB"
            },
            "PT": {"name": "Prepare for Teaching", "description": "Position iSWAP for teaching mode", "parameters": {}, "fw_code": "C0PT"},
            "PC": {"name": "Get Logic Position", "description": "Returns iSWAP logical position state", "parameters": {}, "fw_code": "C0PC"},
            "RG": {"name": "Request Park Status", "parameters": {}, "response": {"rg": "0=not_parked|1=parked"}, "fw_code": "C0RG"},
            "QP": {"name": "Request Plate in iSWAP", "parameters": {}, "response": {"qp": "0=no_plate|1=plate_gripped"}, "fw_code": "C0QP"},
            "QG": {"name": "Request iSWAP Position", "parameters": {}, "response": {"qg": "grip_center_xyz"}, "fw_code": "C0QG"}
        }
    }

    # -------------------------------------------------------------------------
    # CO-RE GRIPPER
    # -------------------------------------------------------------------------
    spec["modules"]["core_gripper"] = {
        "name": "CO-RE Gripper (Plate Transport via PIP Channels)",
        "fw_prefix": "C0",
        "doc_ref": "E2891001a.docx (Master)",
        "description": (
            "Plate handling tool picked up by 2 pipetting channels. Uses the PIP channel "
            "Y/Z drives for plate gripping and transport. Supports landscape/portrait, no rotation."
        ),
        "hardware": {
            "picked_up_by": "2 x 1000uL pipetting channels",
            "plate_height_mm": [5, 43],
            "position_accuracy_mm": 0.5,
            "grip_force_n": [5, 16],
            "default_grip_force_n": 9,
            "max_transport_mass_g": 300,
            "max_per_instrument": 2,
            "rotation": False
        },
        "state_model": {
            "states": ["not_attached", "attached_empty", "plate_gripped", "moving", "error"],
            "transitions": [
                {"from": "not_attached", "to": "attached_empty", "trigger": "ZT_complete"},
                {"from": "attached_empty", "to": "plate_gripped", "trigger": "ZP_complete"},
                {"from": "plate_gripped", "to": "attached_empty", "trigger": "ZR_complete"},
                {"from": "plate_gripped", "to": "moving", "trigger": "ZM_command"},
                {"from": "moving", "to": "plate_gripped", "trigger": "ZM_complete"},
                {"from": "attached_empty", "to": "not_attached", "trigger": "ZS_complete"}
            ]
        },
        "commands": {
            "ZT": {
                "name": "Get CoRe Gripper Tool",
                "description": "Pick up the gripper tool using 2 PIP channels",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position of tool"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "ya": {"type": "int", "unit": "0.1mm", "description": "Y-position lower channel"},
                    "yb": {"type": "int", "unit": "0.1mm", "description": "Y-position upper channel"},
                    "tt": {"type": "int", "description": "Tool type"},
                    "tp": {"type": "int", "unit": "0.1mm", "description": "Z-begin"},
                    "tz": {"type": "int", "unit": "0.1mm", "description": "Z-end"},
                    "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                    "pa": {"type": "int", "description": "Lower channel number"},
                    "pb": {"type": "int", "description": "Upper channel number"}
                },
                "fw_code": "C0ZT"
            },
            "ZS": {
                "name": "Discard CoRe Gripper Tool",
                "description": "Return the gripper tool to its park position",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm"}, "xd": {"type": "int"},
                    "ya": {"type": "int", "unit": "0.1mm"}, "yb": {"type": "int", "unit": "0.1mm"},
                    "tp": {"type": "int", "unit": "0.1mm"}, "tz": {"type": "int", "unit": "0.1mm"},
                    "th": {"type": "int", "unit": "0.1mm"}, "te": {"type": "int", "unit": "0.1mm"},
                    "pa": {"type": "int"}, "pb": {"type": "int"}
                },
                "fw_code": "C0ZS"
            },
            "ZP": {
                "name": "Get Plate (CoRe Gripper)",
                "description": "Pick up a plate using the CoRe gripper tool",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm", "description": "X-position"},
                    "xd": {"type": "int", "range": [0, 1], "description": "X direction"},
                    "yj": {"type": "int", "unit": "0.1mm", "description": "Y grip position"},
                    "yv": {"type": "int", "unit": "0.1mm/s", "description": "Y grip speed"},
                    "zj": {"type": "int", "unit": "0.1mm", "description": "Z grip height"},
                    "zy": {"type": "int", "unit": "0.1mm/s", "description": "Z speed"},
                    "yo": {"type": "int", "unit": "0.1mm", "description": "Open position"},
                    "yg": {"type": "int", "unit": "0.1mm", "description": "Plate grip width"},
                    "yw": {"type": "int", "description": "Grip strength"},
                    "th": {"type": "int", "unit": "0.1mm", "description": "Min traverse height"},
                    "te": {"type": "int", "unit": "0.1mm", "description": "Z-end"}
                },
                "venus_step": "Run_CloseGripper",
                "fw_code": "C0ZP"
            },
            "ZR": {
                "name": "Put Plate (CoRe Gripper)",
                "description": "Place a plate at a position using the CoRe gripper",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm"}, "xd": {"type": "int"},
                    "xg": {"type": "int", "unit": "0.1mm", "description": "X acceleration"},
                    "yj": {"type": "int", "unit": "0.1mm"}, "zj": {"type": "int", "unit": "0.1mm", "description": "Z deposit height"},
                    "zi": {"type": "int", "unit": "0.1mm", "description": "Z press-on distance"},
                    "zy": {"type": "int", "unit": "0.1mm/s"}, "yo": {"type": "int", "unit": "0.1mm"},
                    "th": {"type": "int", "unit": "0.1mm"}, "te": {"type": "int", "unit": "0.1mm"}
                },
                "venus_step": "Run_OpenGripper",
                "fw_code": "C0ZR"
            },
            "ZM": {
                "name": "Move Plate (CoRe Gripper)",
                "description": "Move gripped plate to new position",
                "parameters": {
                    "xs": {"type": "int", "unit": "0.1mm"}, "xd": {"type": "int"},
                    "xg": {"type": "int", "unit": "0.1mm"}, "yj": {"type": "int", "unit": "0.1mm"},
                    "zj": {"type": "int", "unit": "0.1mm"}, "zy": {"type": "int", "unit": "0.1mm/s"},
                    "th": {"type": "int", "unit": "0.1mm"}
                },
                "fw_code": "C0ZM"
            },
            "ZO": {
                "name": "Open CoRe Gripper",
                "description": "Open gripper jaws to release plate",
                "parameters": {"pa": {"type": "int"}, "pb": {"type": "int"}},
                "fw_code": "C0ZO"
            },
            "ZB": {
                "name": "Read Barcode (CoRe Gripper)",
                "description": "Read barcode using CoRe gripper barcode reader",
                "parameters": {
                    "cp": {"type": "int", "description": "Slot number"},
                    "zb": {"type": "int", "unit": "0.1mm", "description": "Min Z"},
                    "zy": {"type": "int", "unit": "0.1mm/s"}, "th": {"type": "int", "unit": "0.1mm"},
                    "ma": {"type": "string", "description": "ROI"}, "mr": {"type": "int"},
                    "bd": {"type": "int"}, "mo": {"type": "int"}
                },
                "response": {"bb": "barcode_data"},
                "fw_code": "C0ZB"
            }
        }
    }

    # -------------------------------------------------------------------------
    # WASH STATION
    # -------------------------------------------------------------------------
    spec["modules"]["wash_station"] = {
        "name": "CR/DC Needle Wash Station",
        "fw_prefix": "C0 (operational) / W1-W2 (diagnostics)",
        "doc_ref": "E2891001a.docx (Master), E289007a.doc",
        "description": (
            "Wash stations for cleaning reusable steel needles or disposable tips. "
            "Supports G1, G3, and CR wash station types. Up to 6 wash stations."
        ),
        "state_model": {
            "states": ["not_initialized", "idle", "washing", "waiting", "error"],
            "transitions": [
                {"from": "not_initialized", "to": "idle", "trigger": "WI_complete"},
                {"from": "idle", "to": "washing", "trigger": "WS_or_WC"},
                {"from": "washing", "to": "idle", "trigger": "wash_complete"},
                {"from": "idle", "to": "waiting", "trigger": "WW_command"},
                {"from": "waiting", "to": "idle", "trigger": "WW_complete"}
            ]
        },
        "commands": {
            "WI": {
                "name": "Initialize Wash Station",
                "description": "Initialize specified wash station",
                "parameters": {"wn": {"type": "int", "range": [1, 6], "description": "Wash station number"}},
                "venus_step": "Run_InitWasher",
                "fw_code": "C0WI"
            },
            "WS": {
                "name": "Start Wash (G3)",
                "description": "Start wash procedure on G3 wash station",
                "parameters": {"wn": {"type": "int", "description": "Wash station number"}},
                "venus_step": "Run_Wash",
                "fw_code": "C0WS"
            },
            "WC": {
                "name": "Start Wash (CR)",
                "description": "Start wash procedure on CR wash station",
                "parameters": {"wn": {"type": "int", "description": "Wash station number"}},
                "fw_code": "C0WC"
            },
            "WW": {
                "name": "Wait for Wash Complete",
                "description": "Block until wash station finishes current cycle",
                "parameters": {"wn": {"type": "int", "description": "Wash station number"}},
                "venus_step": "Run_WaitWash",
                "fw_code": "C0WW"
            },
            "WR": {
                "name": "Repeat Wash",
                "description": "Repeat the previous wash procedure",
                "parameters": {"wn": {"type": "int", "description": "Wash station number"}},
                "fw_code": "C0WR"
            },
            "QF": {
                "name": "Request Fluid Status",
                "description": "Query wash fluid level and waste status",
                "parameters": {"wn": {"type": "int", "description": "Wash station number"}},
                "response": {"qf": "fluid_status"},
                "fw_code": "C0QF"
            }
        }
    }

    # -------------------------------------------------------------------------
    # TEMPERATURE CONTROLLED CARRIER
    # -------------------------------------------------------------------------
    spec["modules"]["temperature_carrier"] = {
        "name": "Temperature Controlled Carrier (TCC / Incubator)",
        "fw_prefix": "C0 (operational) / T1-T2 (diagnostics)",
        "doc_ref": "E2891001a.docx (Master), E289008a.doc",
        "description": (
            "Heating/cooling module for carriers on deck. Up to 2 independent "
            "temperature zones. Controlled via VENUS software."
        ),
        "state_model": {
            "states": ["off", "heating", "at_temperature", "cooling", "error"],
            "transitions": [
                {"from": "off", "to": "heating", "trigger": "HI_or_HC"},
                {"from": "heating", "to": "at_temperature", "trigger": "target_reached"},
                {"from": "at_temperature", "to": "off", "trigger": "HF_command"},
                {"from": "at_temperature", "to": "heating", "trigger": "HI_new_target"}
            ]
        },
        "commands": {
            "HI": {
                "name": "Set Temperature (Immediate)",
                "description": "Set target temperature, returns immediately without waiting to reach it",
                "parameters": {
                    "hi": {"type": "int", "unit": "0.1C", "description": "Target temperature"},
                    "hn": {"type": "int", "range": [1, 2], "description": "Temperature zone number"}
                },
                "venus_step": "Run_Temperate",
                "fw_code": "C0HI"
            },
            "HC": {
                "name": "Set Temperature (Wait)",
                "description": "Set target temperature and wait until reached",
                "parameters": {
                    "hc": {"type": "int", "unit": "0.1C", "description": "Target temperature"},
                    "hn": {"type": "int", "range": [1, 2], "description": "Temperature zone"},
                    "ht": {"type": "int", "unit": "s", "description": "Timeout in seconds"}
                },
                "venus_step": "Run_Temperate",
                "fw_code": "C0HC"
            },
            "HF": {
                "name": "Temperature Off",
                "description": "Turn off temperature control for specified zone",
                "parameters": {"hn": {"type": "int", "range": [1, 2], "description": "Temperature zone"}},
                "fw_code": "C0HF"
            },
            "RP": {
                "name": "Request Temperature",
                "description": "Query current temperature of specified zone",
                "parameters": {"hn": {"type": "int", "range": [1, 2], "description": "Temperature zone"}},
                "response": {"rp": "temperature_0.1C"},
                "venus_step": "Run_GetTemperature",
                "fw_code": "C0RP"
            }
        }
    }

    # -------------------------------------------------------------------------
    # PUMP UNIT (DC Wash Station)
    # -------------------------------------------------------------------------
    spec["modules"]["pump_unit"] = {
        "name": "Pump Unit (DC Wash Station)",
        "fw_prefix": "C0",
        "doc_ref": "E2891001a.docx, E289019a.doc",
        "description": "Pump system for the dual-chamber 96/384 wash station. Handles wash liquid circulation, filling, and draining.",
        "commands": {
            "EF": {"name": "Prime Pump", "description": "Prime the pump unit", "parameters": {}, "fw_code": "C0EF"},
            "EW": {"name": "Start Circulation", "description": "Start wash liquid circulation", "parameters": {}, "fw_code": "C0EW"},
            "EC": {"name": "Check Circulation", "description": "Verify circulation is running", "parameters": {}, "fw_code": "C0EC"},
            "ES": {"name": "Stop Circulation", "description": "Stop wash liquid circulation", "parameters": {}, "fw_code": "C0ES"},
            "EE": {"name": "Drain and Refill", "description": "Drain chamber and refill with fresh liquid", "parameters": {}, "fw_code": "C0EE"},
            "EB": {"name": "Fill Pump", "description": "Fill pump unit chamber", "parameters": {}, "fw_code": "C0EB"},
            "EJ": {"name": "Init Pump Valves", "description": "Initialize pump station valve positions (dual chamber)", "parameters": {}, "fw_code": "C0EJ"},
            "EH": {"name": "Fill Chamber", "description": "Fill selected chamber (dual chamber)", "parameters": {}, "fw_code": "C0EH"},
            "EK": {"name": "Drain Chamber", "description": "Drain selected chamber", "parameters": {}, "fw_code": "C0EK"},
            "EL": {"name": "Drain System", "description": "Drain entire pump system", "parameters": {}, "fw_code": "C0EL"},
            "QE": {"name": "Request Prime Status", "parameters": {}, "response": {"qe": "prime_state"}, "fw_code": "C0QE"},
            "QD": {"name": "Request Dual Chamber Status", "parameters": {}, "response": {"qd": "chamber_state"}, "fw_code": "C0QD"},
            "ET": {"name": "Request Pump Settings", "parameters": {}, "response": {"et": "pump_config"}, "fw_code": "C0ET"},
            "FA": {"name": "Start DC Wash", "description": "Start dual-chamber wash procedure", "parameters": {}, "fw_code": "C0FA"},
            "FB": {"name": "Stop DC Wash", "description": "Stop dual-chamber wash procedure", "parameters": {}, "fw_code": "C0FB"},
            "FP": {"name": "Prime DC Station", "description": "Prime the DC wash station", "parameters": {}, "fw_code": "C0FP"}
        }
    }

    # =========================================================================
    # STUBBED MODULES (non-core, command lists only)
    # =========================================================================
    stubs = [
        ("core384_head", "CO-RE 384 Multi-Probe Head", "C0 (JA/JB/JC/JD/JI/JV)", "E289241a.doc",
         ["JI", "JV", "JB", "JC", "JA", "JD", "EN", "EY", "JG", "JU", "QK", "QJ", "QY"]),
        ("xl_channels", "XL Pipetting Channels (5mL)", "C0 (LA/LD/LP/LR/LI)", "E289243a.doc",
         ["LI", "LP", "LR", "LA", "LD", "LB", "LC", "LE", "LF", "LT", "LS", "LU", "LV", "LM", "LO", "LG",
          "LY", "LZ", "LH", "LJ", "XM", "LL", "LQ", "LK", "UE", "UY", "UB", "UZ", "UD", "UT", "UL", "US", "UF"]),
        ("nano_dispenser", "Nano Dispenser", "C0 (NA/ND/NF/NI/NP/NW/NU/NM/NT)", "E289240a.doc",
         ["NI", "NV", "NP", "NA", "ND", "NF", "NW", "NU", "NM", "NT", "QL", "QN", "RN", "QQ", "QR", "QO", "RR", "QU"]),
        ("tube_gripper", "Tube Gripper Channel", "C0 (FC/FD/FO/FX/FT/FU/FJ/FM/FW/FQ/FN)", "E2891001a.docx",
         ["FC", "FD", "FO", "FX", "FT", "FU", "FJ", "FM", "FW", "FQ", "FN"]),
        ("gel_card_gripper", "Gel Card Gripper", "C0 (CJ/BK/CM/BF/BG/CH/CX/CV/CC/BR/CY/CZ)", "E289251a.doc",
         ["CJ", "BK", "CM", "BF", "BG", "CH", "CX", "CV", "CC", "BR", "CY", "CZ"]),
        ("image_channel", "Imaging Channel", "C0 (IC/ID/IX/IM/IJ/IN)", "E289245a.doc",
         ["IC", "ID", "IX", "IM", "IJ", "IN"]),
        ("robotic_channels", "Robotic Channels (Capper/Decapper)", "C0 (OI/OP/OQ/OE/OK/ON/UM/OV/OW/OL)", "E2891001a.docx",
         ["OI", "OP", "OQ", "OE", "OK", "ON", "UM", "OV", "OW", "OL", "OY", "OZ", "OH", "OJ", "OX", "OM", "OF", "OO", "OG",
          "OA", "OB", "OC", "OD", "OT", "OU"]),
        ("decapper_module", "Decapper Module", "C0 (UI/UW/UP/UO/UC/UV/UR/UG)", "E2891018a.doc",
         ["UI", "UW", "UP", "UO", "UC", "UV", "UR", "UG"]),
        ("puncher", "Puncher System", "C0 (BI/BX/BY/BZ/BE/BW/BJ/BL/BN/BH/BP/BD/BM/CF/BQ/BV/BU/CG/CK/BS/BO)", "E2891010a.doc",
         ["BI", "BX", "BY", "BZ", "BE", "BW", "BJ", "BL", "BN", "BH", "BP", "BD", "BM", "CF", "BQ", "BV", "BU", "CG", "CK", "BS", "BO"]),
        ("head_gripper", "Head Gripper Module", "C0 (via master)", "E289244a.doc",
         ["FC", "FM", "FO", "FU", "FX"]),
        ("heater_shaker", "Hamilton Heater Shaker", "T1/TS", "E289247a.doc",
         ["command_list_in_slave_module"]),
        ("heater_module", "Heater Module", "HG/HX/HY", "E2891021a.doc",
         ["command_list_in_slave_module"]),
        ("washer96", "Hamilton Washer 96", "V1", "E2891013a.doc",
         ["command_list_in_slave_module"]),
        ("centrifuge", "HAM Zentrifuge Module", "CAN slave", "E2891023a.docx",
         ["MI", "MO", "MC", "MP", "MW", "MZ", "MS", "LI", "PI", "HI", "ZI", "ZR", "ZT"]),
        ("gel_card_incubator", "Gel Card Incubator", "TB (CAN slave)", "E2891022a.docx",
         ["TA", "TB", "TO", "BA", "BB", "BP", "BO", "CA", "CB", "CP", "CO", "DA", "DB", "DP", "DO"]),
        ("rd5_process_unit", "RD5 Process Unit", "CAN slave", "E2891016a.docx",
         ["XI", "YI", "SI", "TI", "MA", "MB", "MC", "MD", "ME"]),
        ("rd5_loading_unit", "RD5 Loading Unit", "CAN slave", "E2891017a.docx",
         ["GI", "HI", "LI", "PI", "CS", "CT", "MA", "MB", "MC", "MD", "ME", "MF", "MG", "MH"]),
        ("autoload_2d", "2D AutoLoad Module", "CAN slave", "E2891024a.docx",
         ["CI", "CO", "CA", "CL", "CP", "CT", "CW", "CR", "CU", "CS", "CB", "CD", "CE", "CC", "AH", "BH", "BF"]),
        ("pipetting_head_squeezer", "Pipetting Head Squeezer", "I2C slave", "E2891026a.docx",
         ["SI", "SS", "SA", "SB", "SC", "SO", "SY", "SK"]),
        ("light_controller", "Light Controller Module", "CAN slave", "E2891028a.pdf",
         ["command_list_in_doc"]),
        ("pressure_controller", "Pressure Controller", "CAN slave", "E289242a.doc",
         ["command_list_in_doc"]),
        ("x0_module", "X0 Module (CAN Gateway)", "X0", "E289003a.doc / E2891005a.doc",
         ["command_list_in_doc"]),
    ]

    for stub_id, stub_name, prefix, doc, cmds in stubs:
        spec["modules"][stub_id] = {
            "name": stub_name,
            "fw_prefix": prefix,
            "doc_ref": doc,
            "status": "stubbed",
            "description": f"Stub entry — full command detail to be added. See {doc} for complete specification.",
            "command_codes": cmds
        }

    # =========================================================================
    # VENUS STEP MAPPING
    # =========================================================================
    spec["venus_steps"] = {
        "description": (
            "VENUS software steps organized in three tiers: Power Steps (highest-level wizards), "
            "Easy Steps (composite operations), and Single Steps (direct FW command wrappers). "
            "Each tier decomposes into the one below."
        ),
        "architecture": {
            "flow": "VENUS Method (HSL) -> Step -> Run_* class -> McX* method -> AtsMcX* class -> FW command (C0XX)",
            "source_locations": {
                "run_classes": "Star/src/HxGruCommand/code/Run*.cpp",
                "ats_commands": "Star/src/HxAtsInstrument/Code/AtsMc*.cpp",
                "config": "Star/src/HxGruCommand/Config/ML_STAR.cfg",
                "easy_step_base": "Star/src/HxGruCommand/code/CommandEasyRun*.cpp"
            }
        },
        "power_steps": {
            "description": "Highest-level wizard-based steps with full pipetting workflow configuration",
            "steps": {
                "TransferSamples": {"description": "Transfer samples between source and destination with full tip/asp/disp/eject cycle"},
                "AddReagent": {"description": "Add reagent from trough to multiple destinations"},
                "SerialDilution": {"description": "Perform serial dilution across a plate"},
                "Replicates": {"description": "Create replicate plates from source"},
                "HitPicking": {"description": "Cherry-pick samples based on worklist"},
                "LoadAndMatch": {"description": "Load carriers and match with worklist"}
            }
        },
        "easy_steps": {
            "description": "Composite steps that combine tip handling + liquid handling into one operation",
            "steps": {
                "EasyAspirate": {"id": 1025, "decomposition": ["TipPickUp", "Aspirate"], "fw_commands": ["C0TP", "C0AS"], "venus_run": "Run_EasyAspirate"},
                "EasyDispense": {"id": 1029, "decomposition": ["Dispense", "TipEject"], "fw_commands": ["C0DS", "C0TR"], "venus_run": "Run_EasyDispense"},
                "EasyHead96Aspirate": {"id": 1033, "decomposition": ["Head96TipPickUp", "Head96Aspirate"], "fw_commands": ["C0EP", "C0EA"], "venus_run": "Run_EasyHead96Aspirate"},
                "EasyHead96Dispense": {"id": 1037, "decomposition": ["Head96Dispense", "Head96TipEject"], "fw_commands": ["C0ED", "C0ER"], "venus_run": "Run_EasyHead96Dispense"},
                "EasyHead384Aspirate": {"id": 1290, "decomposition": ["Head384TipPickUp", "Head384Aspirate"], "fw_commands": ["C0JB", "C0JA"], "venus_run": "Run_EasyHead384Aspirate"},
                "EasyHead384Dispense": {"id": 1295, "decomposition": ["Head384Dispense", "Head384TipEject"], "fw_commands": ["C0JD", "C0JC"], "venus_run": "Run_EasyHead384Dispense"},
                "EasyISwapTransport": {"id": 1041, "decomposition": ["GetPlate", "MovePlate", "PutPlate"], "fw_commands": ["C0PP", "C0PM", "C0PR"], "venus_run": "Run_EasyISwapTransport"},
                "EasyCOREGripTransport": {"id": 1045, "decomposition": ["GetGripper", "GetPlate", "MovePlate", "PutPlate", "DiscardGripper"], "fw_commands": ["C0ZT", "C0ZP", "C0ZM", "C0ZR", "C0ZS"], "venus_run": "Run_EasyCOREGripTransport"},
                "EasyZSwapTransport": {"decomposition": ["ZSwapGetPlate", "ZSwapMovePlate", "ZSwapPlacePlate"], "venus_run": "Run_EasyZSwapTransport"},
                "XLEasyAspirate": {"id": 1758, "decomposition": ["XLTipPickUp", "XLAspirate"], "fw_commands": ["C0LP", "C0LA"], "venus_run": "Run_XLEasyAspirate"},
                "XLEasyDispense": {"id": 1762, "decomposition": ["XLDispense", "XLTipEject"], "fw_commands": ["C0LD", "C0LR"], "venus_run": "Run_XLEasyDispense"}
            }
        },
        "single_steps": {
            "description": "Direct FW command wrappers — each maps to exactly one firmware command",
            "pipetting": {
                "Initialize": {"fw_code": "C0DI", "venus_run": "Run_Initialize", "ats_class": "AtsMcInitDispenseChannels"},
                "TipPickUp": {"fw_code": "C0TP", "venus_run": "Run_TipPickUp", "ats_class": "AtsMcPickUpTip"},
                "TipEject": {"fw_code": "C0TR", "venus_run": "Run_TipEject", "ats_class": "AtsMcEjectTip"},
                "Aspirate": {"fw_code": "C0AS", "venus_run": "Run_Aspirate", "ats_class": "AtsMcAspirate"},
                "Dispense": {"fw_code": "C0DS", "venus_run": "Run_Dispense", "ats_class": "AtsMcDispense"},
                "DispenseFly": {"fw_code": "C0DF", "venus_run": "Run_DispenseFly", "ats_class": "AtsMcChannelDispenseFly"},
                "Aspirate2ndPhase": {"fw_code": "C0AS", "venus_run": "Run_Aspirate2ndPhase", "note": "Second phase of split aspiration"},
                "GetLastLiquidLevel": {"fw_code": "C0RL", "venus_run": "Run_GetLastLiquidLevel"},
                "MoveToPosition": {"fw_code": "C0JM", "venus_run": "Run_MoveToPosition"}
            },
            "head96": {
                "Head96TipPickUp": {"fw_code": "C0EP", "venus_run": "Run_Head96TipPickUp", "ats_class": "AtsMc96HeadPickUpTip"},
                "Head96TipEject": {"fw_code": "C0ER", "venus_run": "Run_Head96TipEject", "ats_class": "AtsMc96HeadEjectTip"},
                "Head96Aspirate": {"fw_code": "C0EA", "venus_run": "Run_Head96Aspirate", "ats_class": "AtsMc96HeadAspirate"},
                "Head96Dispense": {"fw_code": "C0ED", "venus_run": "Run_Head96Dispense", "ats_class": "AtsMc96HeadDispense"},
                "Head96Wash": {"fw_code": "C0EG", "venus_run": "Run_Head96Wash"},
                "Head96EmptyWasher": {"fw_code": "C0EU", "venus_run": "Run_Head96EmptyWasher"},
                "Head96Move": {"fw_code": "C0EM", "venus_run": "Run_Head96Move"}
            },
            "head384": {
                "Head384TipPickUp": {"fw_code": "C0JB", "venus_run": "Run_Head384TipPickUp", "ats_class": "AtsMc384HeadPickUpTip"},
                "Head384TipEject": {"fw_code": "C0JC", "venus_run": "Run_Head384TipEject", "ats_class": "AtsMc384HeadEjectTip"},
                "Head384Aspirate": {"fw_code": "C0JA", "venus_run": "Run_Head384Aspirate", "ats_class": "AtsMc384HeadAspirate"},
                "Head384Dispense": {"fw_code": "C0JD", "venus_run": "Run_Head384Dispense", "ats_class": "AtsMc384HeadDispense"},
                "Head384Wash": {"fw_code": "C0JG", "venus_run": "Run_Head384Wash"},
                "Head384EmptyWasher": {"fw_code": "C0JU", "venus_run": "Run_Head384EmptyWasher"},
                "Head384Move": {"fw_code": "C0EN", "venus_run": "Run_Head384Move"}
            },
            "transport_iswap": {
                "GetPlate": {"fw_code": "C0PP", "venus_run": "Run_GetPlate", "ats_class": "AtsMcGetPlate"},
                "PutPlate": {"fw_code": "C0PR", "venus_run": "Run_PutPlate", "ats_class": "AtsMcPutPlate"},
                "MovePlate": {"fw_code": "C0PM", "venus_run": "Run_MovePlate", "ats_class": "AtsMcMovePlate"},
                "ISwapPark": {"fw_code": "C0PG", "venus_run": "Run_ISwapPark", "ats_class": "AtsMcParcPlateHandler"},
                "ReadPlateBarcode": {"fw_code": "C0PB", "venus_run": "Run_ReadPlateBarcode", "ats_class": "AtsMcGripperReadBarcode"}
            },
            "transport_gripper": {
                "OpenGripper": {"fw_code": "C0ZR", "venus_run": "Run_OpenGripper"},
                "CloseGripper": {"fw_code": "C0ZP", "venus_run": "Run_CloseGripper"}
            },
            "transport_zswap": {
                "ZSwapGetPlate": {"fw_code": "C0ZSwap", "venus_run": "Run_ZSwapGetPlate", "ats_class": "AtsMcZSwapGetPlate"},
                "ZSwapPlacePlate": {"venus_run": "Run_ZSwapPlacePlate", "ats_class": "AtsMcZSwapPutPlate"},
                "ZSwapMovePlate": {"venus_run": "Run_ZSwapMovePlate", "ats_class": "AtsMcZSwapMovePlate"},
                "ZSwapReadBarcode": {"venus_run": "Run_ZSwapReadBarcode", "ats_class": "AtsMcZSwapReadBarcode"}
            },
            "carrier": {
                "LoadCarrier": {"fw_code": "C0CL", "venus_run": "Run_LoadCarrier", "ats_class": "AtsMcLoadCarrier"},
                "UnloadCarrier": {"fw_code": "C0CR", "venus_run": "Run_UnloadCarrier", "ats_class": "AtsMcUnloadCarrier"},
                "ReloadCarrier": {"venus_run": "Run_ReloadCarrier"}
            },
            "wash": {
                "NeedleWash": {"fw_code": "C0WS", "venus_run": "Run_NeedleWash", "ats_class": "AtsMcWashNeedle"},
                "WaitUntilNeedleWashed": {"fw_code": "C0WW", "venus_run": "Run_WaitUntilNeedleWashed"}
            },
            "temperature": {
                "TemperatureCarrier": {"fw_code": "C0HI/C0HC", "venus_run": "Run_Temperate"},
                "GetCarrierTemperature": {"fw_code": "C0RP", "venus_run": "Run_GetTemperature"}
            },
            "system": {
                "FirmwareCommand": {"fw_code": "raw", "venus_run": "Run_FirmwareCmd", "note": "Send raw FW command string"},
                "LockFrontCover": {"fw_code": "C0CO/C0HO", "venus_run": "Run_LockFrontCover"},
                "ReadPort": {"fw_code": "C0RW", "venus_run": "Run_ReadPort"},
                "WritePort": {"fw_code": "C0OS", "venus_run": "Run_WritePort"},
                "SetStatusLight": {"fw_code": "C0ST", "venus_run": "Run_SetStatusLight"},
                "StatusLightProgress": {"fw_code": "C0ST", "venus_run": "Run_StatusLightProgress"}
            }
        }
    }

    # =========================================================================
    # CAN NODE NAME TABLE
    # =========================================================================
    spec["can_nodes"] = {
        "description": "CAN bus node name assignments for dynamic slave modules",
        "static_nodes": {
            "C0": "Master Module (LAN Dual Processor Board)",
            "P1-PG": "Pipetting channels 1-16",
            "H0": "CoRe 96 Head / 96 Head II TADM",
            "D0": "CoRe 384 Head",
            "T1": "Temperature Carrier Zone 1 / Heater Shaker",
            "T2": "Temperature Carrier Zone 2",
            "W1": "Wash Station 1-3",
            "W2": "Wash Station 4-6",
            "R0": "iSWAP / Plate Handler",
            "I0": "Barcode Reader",
            "X0": "X0 Gateway Module",
            "N0": "Nano Dispenser",
            "A1": "AutoLoad Module"
        },
        "dynamic_nodes": {
            "HG": "Tube Gripper",
            "IC": "Imaging Channel",
            "CG": "Gel Card Gripper",
            "CP": "Card Puncher",
            "CH": "Card/Plate Handler",
            "VL": "ELISA MTP Washer",
            "MP": "ELISA Photometer",
            "TB": "Gel Card Incubator",
            "RL": "Pooler Loading Unit (RD5)",
            "RP": "Pooler Process Unit (RD5)",
            "LX": "XL Channel broadcast",
            "PX": "PIP Channel broadcast",
            "HX": "Pump Unit broadcast",
            "WX": "Wash Station broadcast",
            "TX": "Incubator broadcast",
            "FX": "ELISA Incubator broadcast",
            "OX": "Robotic Channel broadcast",
            "DX": "Decapper broadcast",
            "CX": "Gel Card Spinner broadcast"
        }
    }

    # =========================================================================
    # ROADMAP
    # =========================================================================
    spec["roadmap"] = {
        "description": "Planned extensions for the digital twin specification",
        "phases": [
            {
                "phase": 1,
                "name": "Core Workflow Complete",
                "status": "done",
                "scope": "Master, PIP channels, 96 Head, AutoLoad, iSWAP, CO-RE Gripper, Wash Station, TCC"
            },
            {
                "phase": 2,
                "name": "Full Command Detail for All Modules",
                "status": "planned",
                "scope": "Expand all stubbed modules with full parameter detail from FW command docs",
                "source": "hamilton_command_specs_extracted.json (3,569 commands, 7,996 parameters)"
            },
            {
                "phase": 3,
                "name": "Deck Layout and Labware Model",
                "status": "planned",
                "scope": "Track positions, carrier types, labware definitions, sequence handling"
            },
            {
                "phase": 4,
                "name": "Liquid Class Model",
                "status": "planned",
                "scope": "Aspiration/dispense parameter sets per liquid type (from CO-RE Liquid Editor)"
            },
            {
                "phase": 5,
                "name": "CAD Integration",
                "status": "planned",
                "scope": "Physical dimensions, collision volumes, 3D geometry when CAD model available"
            },
            {
                "phase": 6,
                "name": "Simulation Engine",
                "status": "planned",
                "scope": "State machine execution, command validation, virtual run traces"
            }
        ]
    }

    return spec


if __name__ == "__main__":
    spec = build()
    out_path = "E:/Users/miho/Dropbox/BFX/ML-API/Hamilton-STAR 2026/hamilton-star-digital-twin.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2, ensure_ascii=False)

    # Stats
    def count_commands(obj, depth=0):
        count = 0
        if isinstance(obj, dict):
            if "fw_code" in obj or "name" in obj and depth > 3:
                count += 1
            for v in obj.values():
                count += count_commands(v, depth+1)
        return count

    total_cmds = count_commands(spec.get("modules", {}))
    print(f"Written to: {out_path}")
    print(f"File size: {os.path.getsize(out_path):,} bytes")
    print(f"Modules: {len(spec['modules'])}")
    print(f"Approximate command entries: {total_cmds}")
    print(f"VENUS single steps mapped: {sum(len(v) for v in spec['venus_steps']['single_steps'].values())}")
    print(f"VENUS easy steps mapped: {len(spec['venus_steps']['easy_steps']['steps'])}")
