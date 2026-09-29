# dvr-scan-py/dvr_scan/extractor.py

import sys
import logging
import os
import json
import argparse

from dvr_scan.idr_parser import IdrParser

try:
    import pyewf
    HAS_EWF = True
except ImportError:
    HAS_EWF = False

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s', handlers=[logging.StreamHandler(sys.stdout)])

class ImageReader:
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
                raise ImportError("pyewf-ctypes is not installed. Required for E01 files. Run: pip install pyewf-ctypes")
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


class VideoExtractor:
    """
    Extracts and cleans a single video data block to create a playable
    H.264 raw video file.
    """
    
    H264_START_CODE = b'\x00\x00\x00\x01'

    def __init__(self, image_reader, output_dir="video_exports"):
        self.reader = image_reader
        self.idr_parser = IdrParser(self.reader)
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)

    def extract_single_block(self, target_offset_str, master_file, extra_offset=0):
        """Main workflow to extract a single video block."""
        
        try:
            with open(master_file, 'r') as f:
                data_block_size = json.load(f)['master_sector']['data_block_size']['value']
        except (FileNotFoundError, KeyError) as e:
            logging.error(f"FATAL: Could not read data block size from '{master_file}'. Error: {e}")
            return False, None

        block_start_addr = int(target_offset_str, 16) + extra_offset

        idr_records = self.idr_parser.parse_single_data_block(block_start_addr, data_block_size)

        if not idr_records:
            logging.error(f"Could not parse IDR table for block {target_offset_str}. Cannot determine video boundaries.")
            return False, None

        video_end_addr = idr_records[0]['address']

        block_info = {"start": block_start_addr, "end": video_end_addr}
        output_filename = os.path.join(self.output_dir, f"video_block_at_{target_offset_str}.h264")
        
        if self._carve_and_clean(block_info, output_filename):
            return True, output_filename
        return False, None


    def _carve_and_clean(self, block_info, output_filename):
        carve_start = block_info['start']
        carve_size = block_info['end'] - block_info['start']

        if carve_size <= 0:
            logging.error("Calculated video data size is zero or negative. Cannot extract.")
            return False
            
        logging.info(f"Carving {carve_size / 1024**2:.2f} MB of raw video data...")
        raw_video_data = self.reader.read(carve_start, carve_size)
        
        logging.info("Cleaning stream: isolating all standard H.264 NAL units...")
        
        cleaned_data = bytearray()
        current_pos = 0
        nal_unit_count = 0
        
        while current_pos < len(raw_video_data):
            start_code_pos = raw_video_data.find(self.H264_START_CODE, current_pos)
            if start_code_pos == -1: break

            next_start_code_pos = raw_video_data.find(self.H264_START_CODE, start_code_pos + 4)
            
            if next_start_code_pos == -1:
                frame_data = raw_video_data[start_code_pos:]
                current_pos = len(raw_video_data)
            else:
                frame_data = raw_video_data[start_code_pos:next_start_code_pos]
                current_pos = next_start_code_pos
            
            cleaned_data.extend(frame_data)
            nal_unit_count += 1
            
        if not cleaned_data:
            logging.error("No H.264 NAL units could be found in the data block.")
            return False

        logging.info(f"Found and stitched together {nal_unit_count} NAL units.")
        
        try:
            logging.info(f"Saving cleaned video stream to '{output_filename}'...")
            with open(output_filename, 'wb') as f:
                f.write(cleaned_data)
            logging.info(f"SUCCESS! File saved. Try opening it with a media player like VLC.")
            return True
        except IOError as e:
            logging.error(f"Failed to write video file. Error: {e}")
            return False

def run_extractor(args):
    """Entry point for the extraction logic."""
    reader = None
    try:
        reader = ImageReader(args.extract_image)
        if not reader.open():
             print(json.dumps({"type": "error", "message": "Failed to open image file."}), flush=True)
             sys.exit(1)
        
        extractor = VideoExtractor(reader, output_dir=args.output_dir)
        success, filepath = extractor.extract_single_block(args.offset, args.master_file, args.extra_offset)
        
        if success:
            print(json.dumps({"type": "extract_complete", "path": filepath}), flush=True)
        else:
            print(json.dumps({"type": "error", "message": "Video extraction failed."}), flush=True)

    except Exception as e:
        logging.critical(f"An unexpected critical error occurred: {e}", exc_info=True)
        print(json.dumps({"type": "error", "message": f"An unexpected error occurred: {e}"}), flush=True)
        sys.exit(1)
    finally:
        if reader: reader.close()

#### File to Modify: `dvr-scan-py/requirements.txt` & `requirements_headless.txt`