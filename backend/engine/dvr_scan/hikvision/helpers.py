import os
import sys
import logging
from datetime import datetime, timezone

try:
    import pyewf
    HAS_EWF = True
except ImportError:
    HAS_EWF = False

class ImageReader:
    def __init__(self, image_path):
        self.image_path = image_path
        self.handle = None
        self.is_ewf = False
        self.image_size = 0

    def open(self):
        if not os.path.exists(self.image_path):
            raise FileNotFoundError(f"Image file not found: {self.image_path}")
        with open(self.image_path, 'rb') as probe:
            ewf_signature = probe.read(8) in (b'EVF\x09\x0d\x0a\xff\x00', b'LVF\x09\x0d\x0a\xff\x00')
        if ewf_signature or self.image_path.lower().endswith(('.e01', '.ewf', '.ex01')):
            if not HAS_EWF:
                raise ImportError("E01/Ex01 reading requires libewf-python (pyewf). Install a compatible libewf build, or supply a decoded raw image.")
            logging.info(f"Opening E01 image file: {self.image_path}")
            filenames = pyewf.glob(self.image_path)
            self.handle = pyewf.handle()
            self.handle.open(filenames)
            self.is_ewf = True
            self.image_size = self.handle.get_media_size()
        else:
            logging.info(f"Opening raw image file: {self.image_path}")
            self.handle = open(self.image_path, 'rb')
            self.is_ewf = False
            self.handle.seek(0, 2)
            self.image_size = self.handle.tell()
        logging.info(f"Image size is {self.image_size} bytes ({self.image_size / 1024**3:.2f} GB)")
        return True

    def close(self):
        if self.handle:
            self.handle.close()
            logging.info("Image file handle closed.")

    def read(self, offset, size):
        if not self.handle:
            raise IOError("Image is not open.")
        if offset < 0 or size < 0 or offset > self.image_size:
            raise ValueError("Read range falls outside the evidence image")
        self.handle.seek(offset)
        return self.handle.read(min(size, self.image_size - offset))

def format_timestamp(ts):
    if ts == 0 or ts >= 0x7FFFFFFF or ts == 0xFFFFFFFF: return "Invalid/Not Set"
    try: return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%d %H:%M:%S (recorder clock)')
    except (OSError, ValueError): return f"Invalid Timestamp ({ts})"

def format_bytes(byte_string):
    return ' '.join(f'{b:02X}' for b in byte_string)

def log_and_format(name, addr, val, is_ts=False):
    readable = format_timestamp(val) if is_ts else hex(val)
    logging.info(f"  Found {name}: {val} ({readable}) at {hex(addr)}")
    return {"value": val, "value_readable": readable, "address": addr, "address_hex": hex(addr)}
