# dvr-scan-py/dvr_scan/hikvision/extractor.py

import logging
import os
import json
import struct

from dvr_scan.hikvision.idr_parser import IdrParser
from dvr_scan.hikvision.helpers import ImageReader

logger = logging.getLogger("dvr_scan")

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
                master_data = json.load(f)
                data_block_size = master_data['master_sector']['data_block_size']['value']
        except (FileNotFoundError, KeyError) as e:
            logger.error(f"FATAL: Could not read data block size from '{master_file}'. Error: {e}")
            return False, None

        block_start_addr = int(target_offset_str, 16) + extra_offset

        idr_records = self.idr_parser.parse_single_data_block(block_start_addr, data_block_size)

        if not idr_records:
            logger.error(f"Could not parse IDR table for block {target_offset_str}. Cannot determine video boundaries.")
            return False, None

        video_end_addr = idr_records[0]['address']

        block_info = {"start": block_start_addr, "end": video_end_addr}
        
        # Sanitize the offset string for use in a filename
        safe_offset_str = target_offset_str.replace('0x', '').lower()
        output_filename = os.path.join(self.output_dir, f"video_block_at_{safe_offset_str}.h264")
        
        if self._carve_and_clean(block_info, output_filename):
            return True, output_filename
        return False, None


    def _carve_and_clean(self, block_info, output_filename):
        """
        Reads the raw video area, strips non-H264 headers, and saves
        the cleaned video stream to a file.
        """
        carve_start = block_info['start']
        carve_size = block_info['end'] - block_info['start']

        if carve_size <= 0:
            logger.error("Calculated video data size is zero or negative. Cannot extract.")
            return False
            
        logger.info(f"Carving {carve_size / 1024**2:.2f} MB of raw video data...")
        raw_video_data = self.reader.read(carve_start, carve_size)
        
        logger.info("Cleaning stream: isolating all standard H.264 NAL units...")
        
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
            logger.error("No H.264 NAL units could be found in the data block.")
            return False

        logger.info(f"Found and stitched together {nal_unit_count} NAL units.")
        
        try:
            logger.info(f"Saving cleaned video stream to '{output_filename}'...")
            with open(output_filename, 'wb') as f:
                f.write(cleaned_data)
            logger.info(f"SUCCESS! File saved. Try opening it with a media player like VLC.")
            return True
        except IOError as e:
            logger.error(f"Failed to write video file. Error: {e}")
            return False