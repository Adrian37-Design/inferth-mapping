import os

log_file = "tracker_debug.log"

if not os.path.exists(log_file):
    print(f"Log file '{log_file}' not found. Waiting for tracker connection...")
else:
    with open(log_file, "r") as f:
        lines = f.readlines()
        print(f"--- LAST 20 TRACKER LOG LINES ---")
        for line in lines[-20:]:
            print(line.strip())
