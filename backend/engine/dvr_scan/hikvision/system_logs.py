import struct
from datetime import datetime, timezone
import sys
import logging
import os
import json
import re

# --- (Standard setup: pyewf import, logging, and ImageReader class) ---
try:
    import pyewf
    HAS_EWF = True
except ImportError:
    HAS_EWF = False

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s', handlers=[logging.StreamHandler(sys.stdout)])

class ImageReader:
    # ... (no changes needed)
    def __init__(self, image_path):
        self.image_path = image_path
        self.handle = None
        self.is_ewf = False
        self.image_size = 0

    def open(self):
        # ... (implementation is the same)
        if not os.path.exists(self.image_path):
            raise FileNotFoundError(f"Image file not found: {self.image_path}")

        if self.image_path.lower().endswith(('.e01', '.ewf')):
            if not HAS_EWF:
                raise ImportError("pyewf is not installed but is required for E01 files. Please run: pip install pyewf")
            self.handle = pyewf.handle()
            self.handle.open(pyewf.glob(self.image_path))
            self.is_ewf = True
            self.image_size = self.handle.get_media_size()
        else:
            self.handle = open(self.image_path, 'rb')
            self.is_ewf = False
            self.handle.seek(0, 2)
            self.image_size = self.handle.tell()
        
        logging.info(f"Image size is {self.image_size} bytes ({self.image_size / 1024**3:.2f} GB)")
        return True

    def close(self):
        if self.handle: self.handle.close()

    def read(self, offset, size):
        if not self.handle: raise IOError("Image is not open.")
        self.handle.seek(offset)
        return self.handle.read(size)

class SystemLogParser:
    """
    Parses Hikvision System Logs with specialized sub-parsers for different
    log types, providing both interpreted data and raw hex for verification.
    """
    
    SYSTEM_LOG_SIGNATURE = b'RATS\x14\x00\x00\x00'
    LOG_TYPES = {
        0x01: "Alarm - Motion Detection or other sensor.",
        0x02: "Exception - An error or unusual event, like Video Loss.",
        0x03: "Operation - A user or system action, like Login or System Startup.",
        0x04: "Information - System status reports, like HDD info or Network Stats."
    }

    def __init__(self, image_reader):
        self.reader = image_reader
        self.analysis_results = {"log_header_info": {}, "system_logs": []}

    # --- Smart Decoding Router ---
    def _decode_log_description(self, log_type_code, raw_bytes):
        """Main router that calls the correct specialized parser."""
        if log_type_code == 0x01: return self._parse_alarm_log(raw_bytes)
        if log_type_code == 0x02: return self._parse_exception_log(raw_bytes)
        if log_type_code == 0x03: return self._parse_operation_log(raw_bytes)
        if log_type_code == 0x04: return self._parse_information_log(raw_bytes)
        return self._parse_generic_log(raw_bytes)

    # --- Specialized Parsers ---
    def _parse_alarm_log(self, raw_bytes):
        return {"parsed_type": "Motion Alarm", "details": "Motion detected.", "raw_hex_preview": self._format_bytes(raw_bytes[:64])}

    def _parse_exception_log(self, raw_bytes):
        try:
            if raw_bytes.startswith(b'\x27'): # Video Loss
                channel_num = struct.unpack('<I', raw_bytes[68:72])[0]
                return {"parsed_type": "Video Exception", "details": {"exception_type": "Video Loss", "channel": channel_num}, "raw_hex_preview": self._format_bytes(raw_bytes[:128])}
        except (struct.error, IndexError): pass
        return self._parse_generic_log(raw_bytes)

    def _parse_operation_log(self, raw_bytes):
        if b'DS-' in raw_bytes: # System Startup Event
            model = re.search(rb'DS-[\w-]{4,}', raw_bytes)
            serial = re.search(rb'CCWR[\w]+', raw_bytes)
            return {"parsed_type": "System Startup", "details": {"model_number": model.group(0).decode() if model else "Not Found", "serial_number": serial.group(0).decode() if serial else "Not Found"}, "raw_hex_preview": self._format_bytes(raw_bytes[:256])}
        if b'admin' in raw_bytes: # User Login Event
            return {"parsed_type": "User Login", "details": {"username": "admin"}, "raw_hex_preview": self._format_bytes(raw_bytes[:128])}
        if raw_bytes.startswith(b'\x43\x00\x00\x00'): # Start Recording
            return {"parsed_type": "Start Recording Command", "details": "The DVR initiated video recording.", "raw_hex_preview": self._format_bytes(raw_bytes[:64])}
        if raw_bytes.startswith(b'\x54\x00\x00\x00'): # Configuration Operation
             return {"parsed_type": "Configuration Operation", "details": "A system configuration was likely checked, saved, or changed.", "raw_hex_preview": self._format_bytes(raw_bytes[:128])}
        return self._parse_generic_log(raw_bytes)

    def _parse_information_log(self, raw_bytes):
        """
        REWRITTEN: This is now a sub-router for Type 4 logs.
        """
        # Sub-type 1: HDD Information (starts with A1, A2, etc.)
        if raw_bytes.startswith(b'\xA1') or raw_bytes.startswith(b'\xA2'):
            return self._parse_hdd_info_log(raw_bytes)
        # Sub-type 2: Periodic System Statistics (starts with AA)
        elif raw_bytes.startswith(b'\xAA'):
            return self._parse_system_stats_log(raw_bytes)
        # Fallback for any other Type 4 log we haven't seen
        return self._parse_generic_log(raw_bytes)

    def _parse_hdd_info_log(self, raw_bytes):
        """Parses a true HDD Information log entry."""
        strings = self._extract_strings(raw_bytes)
        details = {"disk_model": "Unknown", "serial_number": "Unknown", "firmware": "Unknown"}
        for s in strings:
            if s.startswith('ST') or s.startswith('WD'): details['disk_model'] = s
            # Serial numbers are often long and alphanumeric
            elif len(s) > 6 and any(c.isdigit() for c in s) and any(c.isalpha() for c in s): details['serial_number'] = s
            # Firmware often has a specific pattern
            elif len(s) >= 4 and len(s) < 8: details['firmware'] = s
        return {"parsed_type": "HDD Information", "details": details, "raw_hex_preview": self._format_bytes(raw_bytes[:128])}

    def _parse_system_stats_log(self, raw_bytes):
        """Parses the periodic AA... system health/statistics log."""
        try:
            # These values likely represent network or disk I/O counters.
            counter_1 = struct.unpack('<I', raw_bytes[52:56])[0]
            counter_2 = struct.unpack('<I', raw_bytes[88:92])[0]
            return {"parsed_type": "Periodic System Statistics", "details": {"counter_value_1": counter_1, "counter_value_2": counter_2}, "raw_hex_preview": self._format_bytes(raw_bytes[:128])}
        except (struct.error, IndexError):
             return self._parse_generic_log(raw_bytes)

    def _parse_generic_log(self, raw_bytes):
        """Fallback for structures we haven't reverse-engineered yet."""
        strings = self._extract_strings(raw_bytes)
        return {"parsed_type": "Unknown Structure", "extracted_strings": strings if strings else "None", "raw_hex_preview": self._format_bytes(raw_bytes[:128])}

    def _extract_strings(self, raw_bytes):
        """Refined function to find and filter for meaningful readable strings."""
        found_strings = re.findall(rb'[ -~]{4,}', raw_bytes)
        return [s.decode('ascii').strip() for s in found_strings if re.search(rb'[a-zA-Z0-9]', s)]

    # --- Main Workflow and Helper Functions ---
    def run_parser(self, master_sector_file, output_filename, extra_offset=0):
        try:
            with open(master_sector_file, 'r') as f:
                master_data = json.load(f)
            logs_offset = master_data['master_sector']['system_logs_offset']['value']
            logs_size = master_data['master_sector']['system_logs_size']['value']
        except (FileNotFoundError, KeyError) as e:
            logging.error(f"FATAL: Could not read required data from '{master_sector_file}'. Error: {e}")
            return False

        if logs_size == 0:
            logging.warning("Master sector indicates a log size of 0. Nothing to parse.")
            return self._save_results_to_json(output_filename)

        actual_logs_offset = logs_offset + extra_offset
        logging.info(f"\n--- Reading System Logs Block (with +{extra_offset} byte offset adjustment) ---")
        logging.info(f"Reading {logs_size} bytes starting from adjusted offset {hex(actual_logs_offset)}")
        logs_data_block = self.reader.read(actual_logs_offset, logs_size)
        
        self._parse_and_store_header(logs_data_block, actual_logs_offset)
        
        return self._save_results_to_json(output_filename)

    def _parse_and_store_header(self, logs_data_block, base_offset):
        first_sig_pos = logs_data_block.find(self.SYSTEM_LOG_SIGNATURE)
        if first_sig_pos == -1:
            logging.warning(f"No log signatures found in the data block.")
            return
            
        if first_sig_pos > 0:
            logging.info(f"Detected a data header of {first_sig_pos} bytes before the first log entry.")
            header_data = logs_data_block[:first_sig_pos]
            self.analysis_results["log_header_info"] = {
                "start_address": base_offset, "start_address_hex": hex(base_offset),
                "size_bytes": first_sig_pos, "raw_hex_preview": self._format_bytes(header_data[:128])
            }
        
        actual_logs_data = logs_data_block[first_sig_pos:]
        logs_start_offset = base_offset + first_sig_pos
        self._parse_log_entries(actual_logs_data, logs_start_offset)

    def _parse_log_entries(self, logs_data, base_offset):
        logging.info("\n--- Parsing Log Entries ---")
        current_pos = 0; log_count = 0
        while current_pos < len(logs_data):
            sig_pos = logs_data.find(self.SYSTEM_LOG_SIGNATURE, current_pos)
            if sig_pos == -1: break

            next_sig_pos = logs_data.find(self.SYSTEM_LOG_SIGNATURE, sig_pos + 1)
            entry_data_end = next_sig_pos if next_sig_pos != -1 else len(logs_data)
            data_start = sig_pos + len(self.SYSTEM_LOG_SIGNATURE)
            entry_data = logs_data[data_start:entry_data_end]

            if len(entry_data) < 6:
                current_pos = sig_pos + 1; continue
            try:
                timestamp = struct.unpack('<I', entry_data[0:4])[0]
                log_type = struct.unpack('<H', entry_data[4:6])[0]
                description_obj = self._decode_log_description(log_type, entry_data[6:])
                log_entry = {
                    "entry_number": log_count + 1, "address": base_offset + sig_pos,
                    "address_hex": hex(base_offset + sig_pos), "timestamp_unix": timestamp,
                    "timestamp_readable": self._format_timestamp(timestamp), "log_type_code": log_type,
                    "log_type_name": self.LOG_TYPES.get(log_type, "Unknown"), "description": description_obj
                }
                self.analysis_results["system_logs"].append(log_entry)
                log_count += 1
            except struct.error:
                logging.warning(f"Could not parse log entry at {hex(base_offset + sig_pos)}. Skipping.")
            current_pos = sig_pos + 1
        logging.info(f"Found and parsed {log_count} system log entries.")

    def _save_results_to_json(self, filename):
        logging.info(f"\n--- Saving results to {filename} ---")
        self.analysis_results['image_info'] = {"filename": os.path.basename(self.reader.image_path)}
        try:
            os.makedirs(os.path.dirname(filename), exist_ok=True)
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(self.analysis_results, f, indent=4)
            logging.info(f"Successfully wrote system log analysis to {filename}")
            return True
        except (IOError, TypeError) as e:
            logging.error(f"Failed to write to JSON file. Error: {e}")
            return False

    def _format_timestamp(self, ts):
        if ts == 0 or ts >= 0x7FFFFFFF: return "Invalid/Not Set"
        try: return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%d %H:%M:%S (recorder clock)')
        except (OSEError, ValueError): return f"Invalid Timestamp ({ts})"
    
    def _format_bytes(self, byte_string):
        return ' '.join(f'{b:02X}' for b in byte_string)

def main():
    config_filename = "config.json"
    logging.info(f"Attempting to read settings from '{config_filename}'...")
    try:
        with open(config_filename, 'r') as f:
            config = json.load(f)
        image_path = config['image_path']
        master_sector_file = config['output_files']['master_sector']
        system_logs_file = config['output_files']['system_logs']
        extra_offset = config.get('extra_offset', 0)
        if extra_offset > 0:
            logging.info(f"Applying a global extra offset of {extra_offset} bytes.")
    except (FileNotFoundError, KeyError) as e:
        logging.critical(f"FATAL: Could not read required settings from '{config_filename}'. Error: {e}")
        sys.exit(1)

    reader = None
    try:
        reader = ImageReader(image_path)
        if not reader.open(): sys.exit(1)
        parser = SystemLogParser(reader)
        if parser.run_parser(master_sector_file, system_logs_file, extra_offset):
            logging.info("\nSystem log parsing completed.")
        else:
            logging.error("\nSystem log parsing failed.")
    except (FileNotFoundError, ImportError, IOError) as e:
        logging.critical(f"A critical error occurred: {e}")
        sys.exit(1)
    finally:
        if reader: reader.close()

if __name__ == "__main__":
    main()