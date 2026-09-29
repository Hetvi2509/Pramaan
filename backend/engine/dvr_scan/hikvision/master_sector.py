# dvr-scan-py/dvr_scan/hikvision/master_sector.py

import struct
import logging
import os
import json

from dvr_scan.hikvision.helpers import format_timestamp, format_bytes, log_and_format

class MasterSectorParser:
    FILESYSTEM_SIGNATURE = b'HIKVISION@HANGZHOU'

    def __init__(self, image_reader):
        self.reader = image_reader
        self.analysis_results = {}
        self.extra_offset = 0

    def run_parser(self, output_filename):
        self.analysis_results['image_info'] = {
            'filename': os.path.basename(self.reader.image_path),
            'full_path': self.reader.image_path,
            'size_bytes': self.reader.image_size
        }
        if not self._find_and_parse_master_sector():
            return None
        if not self._save_results_to_json(output_filename):
            return None
        return self.extra_offset

    def _find_and_parse_master_sector(self):
        logging.info("\n--- Locating and Parsing the Master Sector ---")
        SEARCH_START_OFFSET = 0x200
        search_block = self.reader.read(SEARCH_START_OFFSET, 4096)
        try:
            sig_index_in_block = search_block.index(self.FILESYSTEM_SIGNATURE)
        except ValueError:
            logging.error(f"FATAL: Could not find '{self.FILESYSTEM_SIGNATURE.decode()}' signature.")
            return False
        
        absolute_sig_start_addr = SEARCH_START_OFFSET + sig_index_in_block
        self.analysis_results['master_sector'] = {}
        self.extra_offset = absolute_sig_start_addr - SEARCH_START_OFFSET
        logging.info(f"Calculated an extra offset of {self.extra_offset} bytes ({hex(self.extra_offset)})")
        self.analysis_results['master_sector']['extra_offset'] = self.extra_offset
        self.analysis_results['master_sector']['signature_address'] = absolute_sig_start_addr

        parsing_block_start = absolute_sig_start_addr
        data_to_parse = self.reader.read(parsing_block_start, 512)

        try:
            def _log(field_key, field_name, start_addr, value, raw_bytes):
                self.analysis_results['master_sector'][field_key] = {
                    "value": value, "value_hex": hex(value), "address": start_addr,
                    "address_hex": hex(start_addr), "raw_bytes": format_bytes(raw_bytes)
                }

            offset = len(self.FILESYSTEM_SIGNATURE) + 38
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('disk_capacity', 'Disk Capacity', addr, val, raw)

            offset += 8 + 16
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('system_logs_offset', 'System Logs Offset', addr, val, raw)

            # ... continue parsing all other fields similarly ...
            offset += 8
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('system_logs_size', 'System Logs Size', addr, val, raw)

            offset += 8 + 8
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('video_data_offset', 'Video Data Offset', addr, val, raw)
            
            offset += 8 + 8
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('data_block_size', 'Data Block Size', addr, val, raw)
            
            offset += 8
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+4]
            val = struct.unpack('<I', raw)[0]
            _log('total_data_blocks', 'Total Data Blocks', addr, val, raw)
            
            offset += 4 + 4
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('hikbtree1_offset', 'HIKBTREE1 Offset', addr, val, raw)

            offset += 8
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+4]
            val = struct.unpack('<I', raw)[0]
            _log('hikbtree1_size', 'HIKBTREE1 Size', addr, val, raw)
            
            offset += 4 + 4
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+8]
            val = struct.unpack('<Q', raw)[0]
            _log('hikbtree2_offset', 'HIKBTREE2 Offset', addr, val, raw)

            offset += 8
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+4]
            val = struct.unpack('<I', raw)[0]
            _log('hikbtree2_size', 'HIKBTREE2 Size', addr, val, raw)

            offset += 4 + 60
            addr = parsing_block_start + offset
            raw = data_to_parse[offset:offset+4]
            val = struct.unpack('<I', raw)[0]
            self.analysis_results['master_sector']['system_init_time'] = {
                "value_unix": val, "value_readable": format_timestamp(val), "address": addr,
                "address_hex": hex(addr), "raw_bytes": format_bytes(raw)
            }
        except (struct.error, IndexError) as e:
            logging.error(f"FATAL: Failed to parse master sector data. Error: {e}")
            return False
        return True

    def _save_results_to_json(self, filename):
        logging.info(f"\n--- Saving results to {filename} ---")
        try:
            os.makedirs(os.path.dirname(filename), exist_ok=True)
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(self.analysis_results, f, indent=4)
            logging.info(f"Successfully wrote analysis data to {filename}")
            return True
        except (IOError, TypeError) as e:
            logging.error(f"Failed to write to JSON file. Error: {e}")
            return False