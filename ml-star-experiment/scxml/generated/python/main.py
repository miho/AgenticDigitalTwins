# main.py — entry point for the PipChannelStateMachine state machine.
#
# Usage:
#   python main.py                              # interactive mode (stdin)
#   python main.py --events ev1 ev2 ev3         # batch mode (runs events then exits)
#   python main.py --events ev1 ev2 --verbose   # batch mode with logging
#
# The ContinuousExecutor runs on a background thread and processes
# delayed events (<send delay="..."/>) automatically.

import sys
import time
from scxmlgen.executor import ContinuousExecutor
from scxmlgen.trace import JsonlTraceWriter
from pip_channel_state_machine import PipChannelStateMachine


def parse_args():
    events = []
    verbose = False
    in_events = False
    for arg in sys.argv[1:]:
        if arg in ("--events", "-e"):
            in_events = True
        elif arg in ("--verbose", "-v"):
            verbose = True
        elif in_events:
            events.append(arg)
    return events, verbose


def main() -> None:
    events, verbose = parse_args()

    machine = PipChannelStateMachine()
    if verbose:
        machine.set_logger(lambda msg: print(f"[LOG] {msg}"))

    with ContinuousExecutor(machine) as executor:
        executor.start()

        if events:
            # ── Batch mode ──────────────────────────────────────────────
            print(f"Active states: {machine.active_states}")
            for ev in events:
                if machine.is_finished:
                    break
                print(f"> {ev}")
                executor.send(ev)
                time.sleep(0.005)
                print(f"Active states: {machine.active_states}")
            if machine.is_finished:
                print("State machine has finished.")
        else:
            # ── Interactive mode ────────────────────────────────────────
            print("=== PipChannelStateMachine State Machine Demo ===")
            print()
            print(f"Active states: {machine.active_states}")
            print()
            print("Type an event name and press Enter ('quit' to exit):")
            print()

            while not machine.is_finished:
                try:
                    user_input = input("> ").strip()
                except EOFError:
                    break

                if user_input in ("quit", "exit"):
                    break
                if not user_input:
                    continue

                executor.send(user_input)
                print(f"Active states: {machine.active_states}")
                if machine.is_finished:
                    print("State machine has finished.")

            print("Goodbye!")

    # === With Tracing (for debugging) ===
    # Records all state transitions, events, and actions to a JSONL file.
    #
    # with JsonlTraceWriter("trace.jsonl") as writer:
    #     machine = PipChannelStateMachine()
    #     machine.set_trace_listener(writer)
    #     machine.start()
    #     machine.send("myEvent")


if __name__ == "__main__":
    main()
