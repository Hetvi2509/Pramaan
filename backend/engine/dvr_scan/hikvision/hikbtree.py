#!/usr/bin/env python3
# hikbtree.py (Corrected version)

import struct
from datetime import datetime, timezone
import sys
import logging
import os
import json

# --- (Standard setup: pyewf import, logging, and ImageReader class) ---
try:
    import pyewf
    HAS_EWF = True
except ImportError:
    HAS_EWF = False

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s', handlers=[logging.StreamHandler(sys.stdout)])

class ImageReader:
    # ... (This class is identical to the previous scripts and does not need changes) ...
    def __init__(self, image_path):
        self.image_path = image_path
        self.handle = None
        self.is_ewf = False
        self.image_size = 0

    def open(self):
        if not os.path.exists(self.image_path):
            raise FileNotFoundError(f"Image file not found: {self.image_path}")
        if self.image_path.lower().endswith(('.e01', '.ewf')):
            if not HAS_EWF:
                raise ImportError("pyewf is not installed. Required for E01 files. Run: pip install pyewf")
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

class HikbtreeParser:
    """
    Parses the HIKBTREE structure from a Hikvision DVR image, including the
    header, page list, individual pages, and footer.
    """
    
    HIKBTREE_SIGNATURE = b'HIKBTREE'

    def __init__(self, image_reader):
        self.reader = image_reader
        self.analysis_results = {}

    def run_parser(self, master_file, output_file, extra_offset=0):
        """Main workflow to orchestrate the parsing of the HIKBTREE."""
        try:
            with open(master_file, 'r') as f:
                master_data = json.load(f)['master_sector']
            hbt_base_offset = master_data['hikbtree1_offset']['value']
        except (FileNotFoundError, KeyError) as e:
            logging.error(f"FATAL: Could not read HIKBTREE offset from '{master_file}'. Error: {e}")
            return False

        header_info = self._parse_header(hbt_base_offset, extra_offset)
        if not header_info: return False
        self.analysis_results['header'] = header_info

        page_list_info = self._parse_page_list(header_info['page_list_address']['value'], extra_offset)
        if not page_list_info: return False
        self.analysis_results['page_list_summary'] = page_list_info

        page_offsets = [p['page_offset']['value'] for p in page_list_info['page_metadata']]
        all_pages_data = self._parse_all_pages(page_offsets, extra_offset)
        self.analysis_results['pages'] = all_pages_data

        footer_info = self._parse_footer(header_info['footer_address']['value'], extra_offset)
        if not footer_info: return False
        self.analysis_results['footer'] = footer_info
        
        return self._save_results_to_json(output_file)

    def _parse_header(self, base_addr, extra_offset):
        """Parses the HIKBTREE Header."""
        logging.info(f"\n--- 1. Parsing HIKBTREE Header at {hex(base_addr)} ---")
        data_addr = base_addr + extra_offset
        data = self.reader.read(data_addr, 256)

        if not data.startswith(self.HIKBTREE_SIGNATURE):
            logging.error(f"HIKBTREE signature not found at {hex(data_addr)}!")
            return None
        
        logging.info(f"  Found Signature 'HIKBTREE' at {hex(data_addr)}")
        
        try:
            sig_len = len(self.HIKBTREE_SIGNATURE)
            created_time_addr = data_addr + sig_len + 36
            created_time = struct.unpack('<I', data[sig_len+36 : sig_len+40])[0]

            footer_offset_addr = created_time_addr + 4
            footer_offset = struct.unpack('<Q', data[sig_len+40 : sig_len+48])[0]

            pagelist_offset_addr = footer_offset_addr + 8 + 8
            pagelist_offset = struct.unpack('<Q', data[sig_len+56 : sig_len+64])[0]
            
            page1_offset_addr = pagelist_offset_addr + 8
            page1_offset = struct.unpack('<Q', data[sig_len+64 : sig_len+72])[0]

            return {
                "created_time": self._log_and_format("Created Time", created_time_addr, created_time, is_ts=True),
                "footer_address": self._log_and_format("Footer Offset", footer_offset_addr, footer_offset),
                "page_list_address": self._log_and_format("Page List Offset", pagelist_offset_addr, pagelist_offset),
                "page_1_address": self._log_and_format("Page 1 Offset (from header)", page1_offset_addr, page1_offset),
            }
        except (struct.error, IndexError) as e:
            logging.error(f"Failed to parse header structure. Error: {e}")
            return None

    def _parse_page_list(self, base_addr, extra_offset):
        """Parses the Page List structure."""
        logging.info(f"\n--- 2. Parsing Page List at {hex(base_addr)} ---")
        data_addr = base_addr + extra_offset
        data = self.reader.read(data_addr, 80)

        try:
            total_pages = struct.unpack('<I', data[0:4])[0]
            size = 80 + total_pages * 48
            if size > self.reader.image_size - data_addr:
                raise ValueError("HIKBTREE page list exceeds evidence boundaries")
            data = self.reader.read(data_addr, size)
            page_list_summary = {"total_pages": self._log_and_format("Total Pages", data_addr, total_pages)}
            
            page_metadata = []
            # --- THIS IS THE FIX ---
            # Corrected starting offset from 76 to 80
            current_offset_in_block = 80
            # --- END OF FIX ---

            for i in range(total_pages):
                entry_addr = data_addr + current_offset_in_block
                entry_data = data[current_offset_in_block : current_offset_in_block + 48]
                if len(entry_data) < 48:
                    logging.warning(f"  Ran out of data in page list after {i} pages.")
                    break

                page_offset = struct.unpack('<Q', entry_data[0:8])[0]
                channel = struct.unpack('<B', entry_data[17:18])[0]
                start_time = struct.unpack('<I', entry_data[24:28])[0]
                end_time = struct.unpack('<I', entry_data[28:32])[0]
                first_block_offset = struct.unpack('<Q', entry_data[32:40])[0]
                
                logging.info(f"  Parsed metadata for Page #{i+1} at {hex(entry_addr)}")
                page_metadata.append({
                    "page_number": i + 1,
                    "page_offset": {"value": page_offset, "address": entry_addr},
                    "channel": {"value": channel, "address": entry_addr + 17},
                    "first_entry_start_time": {"value": start_time, "readable": self._format_timestamp(start_time)},
                    "first_entry_end_time": {"value": end_time, "readable": self._format_timestamp(end_time)},
                    "first_entry_data_offset": {"value": first_block_offset}
                })
                current_offset_in_block += 48
            
            page_list_summary["page_metadata"] = page_metadata
            return page_list_summary

        except (struct.error, IndexError) as e:
            logging.error(f"Failed to parse page list structure. Error: {e}")
            return None

    def _parse_all_pages(self, page_offsets, extra_offset):
        """Iterates through page offsets and parses each one."""
        logging.info(f"\n--- 3. Parsing {len(page_offsets)} Individual Pages ---")
        all_pages = {}
        for i, page_addr in enumerate(page_offsets):
            logging.info(f"  -> Parsing Page #{i+1} at {hex(page_addr)}")
            page_data = self._parse_single_page(page_addr, extra_offset)
            all_pages[f"page_{i+1}"] = page_data
        return all_pages

    def _parse_single_page(self, base_addr, extra_offset):
        """Parses the data block entries within a single page."""
        data_addr = base_addr + extra_offset
        page_content = self.reader.read(data_addr, 4096)
        
        try:
            next_page_offset = struct.unpack('<Q', page_content[16:24])[0]
            is_last_page = (next_page_offset == 0xFFFFFFFFFFFFFFFF)
            
            page_info = {
                "next_page_address": hex(next_page_offset),
                "is_last_page": is_last_page,
                "entries": []
            }
            
            current_offset_in_page = 24 + 56
            entry_num = 0

            while current_offset_in_page + 48 <= len(page_content):
                entry_data = page_content[current_offset_in_page : current_offset_in_page + 48]
                if not entry_data.startswith(b'\xFF' * 8): break
                
                existence_bytes = entry_data[8:16]
                channel = struct.unpack('<B', entry_data[17:18])[0]
                start_time = struct.unpack('<I', entry_data[24:28])[0]
                end_time = struct.unpack('<I', entry_data[28:32])[0]
                data_offset = struct.unpack('<Q', entry_data[32:40])[0]
                
                page_info["entries"].append({
                    "entry_number_in_page": entry_num + 1,
                    "address": hex(data_addr + current_offset_in_page),
                    "existence": "Has Video Data" if existence_bytes == (b'\x00' * 8) else "No Video/Recording",
                    "channel": channel,
                    "start_time": {"value": start_time, "readable": self._format_timestamp(start_time)},
                    "end_time": {"value": end_time, "readable": self._format_timestamp(end_time)},
                    "data_block_offset": hex(data_offset)
                })
                entry_num += 1
                current_offset_in_page += 48
            
            return page_info

        except (struct.error, IndexError) as e:
            logging.error(f"    Failed to parse page at {hex(base_addr)}. Error: {e}")
            return {"error": str(e)}

    def _parse_footer(self, base_addr, extra_offset):
        """Parses the HIKBTREE Footer."""
        logging.info(f"\n--- 4. Parsing HIKBTREE Footer at {hex(base_addr)} ---")
        data_addr = base_addr + extra_offset
        data = self.reader.read(data_addr, 32)
        
        try:
            if not data.startswith(b'\xFF' * 8):
                logging.warning("Footer does not start with expected FF padding.")

            last_page_offset_addr = data_addr + 8
            last_page_offset = struct.unpack('<Q', data[8:16])[0]

            return { "last_page_address": self._log_and_format("Last Page Offset", last_page_offset_addr, last_page_offset) }
        except (struct.error, IndexError) as e:
            logging.error(f"Failed to parse footer structure. Error: {e}")
            return None

    # --- Helper functions ---
    def _log_and_format(self, name, addr, val, is_ts=False):
        readable = self._format_timestamp(val) if is_ts else hex(val)
        logging.info(f"  Found {name}: {val} ({readable}) at {hex(addr)}")
        return {"value": val, "value_readable": readable, "address": addr, "address_hex": hex(addr)}

    def _save_results_to_json(self, filename):
        logging.info(f"\n--- Saving HIKBTREE analysis to {filename} ---")
        self.analysis_results['image_info'] = {"filename": os.path.basename(self.reader.image_path)}
        try:
            os.makedirs(os.path.dirname(filename), exist_ok=True)
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(self.analysis_results, f, indent=4)
            logging.info(f"Successfully wrote analysis to {filename}")
            return True
        except (IOError, TypeError) as e:
            logging.error(f"Failed to write to JSON file. Error: {e}")
            return False

    def _format_timestamp(self, ts):
        if ts == 0 or ts >= 0x7FFFFFFF or ts == 0xFFFFFFFF: return "Invalid/Not Set"
        try: return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%d %H:%M:%S (recorder clock)')
        except (OSError, ValueError): return f"Invalid Timestamp ({ts})"

def main():
    config_filename = "config.json"
    logging.info(f"Reading settings from '{config_filename}'...")
    try:
        with open(config_filename, 'r') as f:
            config = json.load(f)
        image_path = config['image_path']
        master_file = config['output_files']['master_sector']
        output_file = config['output_files']['hikbtree']
        extra_offset = config.get('extra_offset', 0)
    except (FileNotFoundError, KeyError) as e:
        logging.critical(f"FATAL: Config file '{config_filename}' is missing required data. Error: {e}")
        sys.exit(1)

    reader = None
    try:
        reader = ImageReader(image_path)
        if not reader.open(): sys.exit(1)
        
        parser = HikbtreeParser(reader)
        if parser.run_parser(master_file, output_file, extra_offset):
            logging.info("\nHIKBTREE parsing completed successfully.")
        else:
            logging.error("\nHIKBTREE parsing failed.")
    except Exception as e:
        logging.critical(f"An unexpected critical error occurred: {e}", exc_info=True)
        sys.exit(1)
    finally:
        if reader: reader.close()

if __name__ == "__main__":
    main()
