import struct
from datetime import datetime
import logging

class IdrParser:
    IDR_SIGNATURE = b'OFNI'
    IDR_RECORD_SIZE = 56

    def __init__(self, image_reader):
        self.reader = image_reader

    def parse_single_data_block(self, block_start_addr, block_size):
        """
        Parses IDR records from a data block.
        
        CRITICAL: DVR systems can have non-monotonic timestamps within a block because:
        1. Multiple camera channels recording to same block
        2. Recording paused/resumed
        3. System clock adjustments
        
        We must be lenient and only filter truly invalid timestamps.
        """
        # Search the last 1% of the block for the IDR table
        search_buffer_size = max(int(block_size / 100), 100000)
        block_end_addr = block_start_addr + block_size
        read_start_addr = block_end_addr - search_buffer_size

        logging.info(f"  Reading {search_buffer_size / 1024:.0f} KB from the end of the data block to find IDR table...")

        try:
            data_chunk = self.reader.read(read_start_addr, search_buffer_size)
        except Exception as e:
            logging.error(f"  Could not read data from offset {hex(read_start_addr)}. Error: {e}")
            return None

        # Find all IDR records by searching for the signature
        idr_records = []
        current_search_end = len(data_chunk)
        
        while True:
            sig_pos_in_chunk = data_chunk.rfind(self.IDR_SIGNATURE, 0, current_search_end)
            
            if sig_pos_in_chunk == -1:
                break
            
            record_addr = read_start_addr + sig_pos_in_chunk
            record_data = data_chunk[sig_pos_in_chunk : sig_pos_in_chunk + self.IDR_RECORD_SIZE]
            
            if len(record_data) < self.IDR_RECORD_SIZE:
                break

            try:
                rec_size = struct.unpack('<I', record_data[4:8])[0]
                if rec_size != 56:
                    current_search_end = sig_pos_in_chunk
                    continue
                
                timestamp = struct.unpack('<I', record_data[24:28])[0]
                
                # CRITICAL: Very lenient validation
                # Accept any timestamp from 2010 onwards
                EPOCH_2010 = 1262304000  # 2010-01-01 00:00:00 UTC
                EPOCH_2038 = 2147483647  # 2038-01-19 03:14:07 UTC
                
                if EPOCH_2010 <= timestamp <= EPOCH_2038:
                    record = {
                        "address": record_addr,
                        "timestamp_unix": timestamp,
                        "timestamp_readable": self._format_timestamp(timestamp)
                    }
                    idr_records.append(record)
                
            except (struct.error, IndexError) as e:
                logging.warning(f"  Could not parse record at {hex(record_addr)}. Error: {e}")
                break 

            current_search_end = sig_pos_in_chunk
        
        if not idr_records:
            logging.warning("  No valid IDR records found in this data block.")
            return None
        
        # Reverse to get chronological file order (oldest to newest)
        idr_records.reverse()
        
        # CRITICAL FIX: Group by time clusters instead of strict ordering
        # This handles multi-channel DVRs where timestamps interleave
        cleaned_records = self._cluster_and_clean_timestamps(idr_records)
        
        if not cleaned_records or len(cleaned_records) < 2:
            logging.warning(f"  Insufficient valid frames after cleaning: {len(cleaned_records) if cleaned_records else 0}")
            return None
        
        logging.info(f"  Successfully parsed {len(cleaned_records):,} valid IDR records for this block.")
        
        start_date = datetime.fromtimestamp(cleaned_records[0]['timestamp_unix']).strftime('%Y-%m-%d %H:%M:%S')
        end_date = datetime.fromtimestamp(cleaned_records[-1]['timestamp_unix']).strftime('%Y-%m-%d %H:%M:%S')
        duration = cleaned_records[-1]['timestamp_unix'] - cleaned_records[0]['timestamp_unix']
        
        logging.info(f"  Time range: {start_date} UTC to {end_date} UTC ({duration}s / {duration/3600:.1f}h)")
        
        return cleaned_records

    def _cluster_and_clean_timestamps(self, records):
        """
        Groups timestamps into clusters and removes only extreme outliers.
        
        This handles DVR systems where:
        - Multiple channels have interleaved timestamps
        - Recording was paused/resumed
        - But we still want to preserve the valid time range
        """
        if not records or len(records) < 2:
            return records
        
        # Get all timestamps
        timestamps = [r['timestamp_unix'] for r in records]
        
        # Find min and max
        min_ts = min(timestamps)
        max_ts = max(timestamps)
        duration = max_ts - min_ts
        
        # If duration is reasonable (< 30 days), accept all records
        MAX_REASONABLE_DURATION = 30 * 24 * 3600  # 30 days
        
        if duration <= MAX_REASONABLE_DURATION:
            # Sort by timestamp for consistent ordering
            sorted_records = sorted(records, key=lambda x: x['timestamp_unix'])
            logging.debug(f"  Accepted all {len(sorted_records)} records (duration: {duration/3600:.1f}h)")
            return sorted_records
        
        # If duration is huge, there are likely outliers
        # Use median-based filtering
        timestamps_sorted = sorted(timestamps)
        median_idx = len(timestamps_sorted) // 2
        median = timestamps_sorted[median_idx]
        
        # Keep records within 15 days of median
        WINDOW = 15 * 24 * 3600  # 15 days
        
        filtered = []
        removed = 0
        
        for record in records:
            ts = record['timestamp_unix']
            if abs(ts - median) <= WINDOW:
                filtered.append(record)
            else:
                removed += 1
                logging.debug(f"  Removed outlier: {self._format_timestamp(ts)} (too far from median)")
        
        if removed > 0:
            logging.info(f"  Removed {removed} outlier timestamps")
        
        # Sort by timestamp
        filtered.sort(key=lambda x: x['timestamp_unix'])
        
        return filtered

    def _format_timestamp(self, ts):
        """Format Unix timestamp to human-readable string."""
        if ts == 0 or ts >= 0x7FFFFFFF:
            return "Invalid/Not Set"
        try:
            return datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S UTC')
        except (OSError, ValueError):
            return f"Invalid Timestamp ({ts})"
