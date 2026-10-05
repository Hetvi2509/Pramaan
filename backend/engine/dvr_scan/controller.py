# dvr-scan-py/dvr_scan/controller.py

import json
import logging
import sys
import os
import typing as ty
from pathlib import Path

from dvr_scan.cli import get_cli_parser
from dvr_scan.config import ConfigRegistry, ConfigLoadFailure
from dvr_scan.scanner import DetectorType
from dvr_scan.shared import ScanSettings, init_logging, init_scanner, logfile_path, setup_logger
import dvr_scan

logger = logging.getLogger("dvr_scan")
LOGFILE_PATH = logfile_path(name_prefix="dvr-scan")

def run_ocr_command(settings):
    """Handles the OCR task."""
    logger = logging.getLogger("dvr_scan")
    try:
        from dvr_scan.ocr_engine import OCREngine
        args = settings.get_arg(None)
        
        engine = OCREngine()
        if args.video:
            from dvr_scan.ocr_video import annotate_video
            result = annotate_video(engine, args.video, args.output, args.sample_rate, args.confidence)
        else:
            result = engine.process_image_from_path(args.image)
        if result.get("status") == "error":
            raise RuntimeError(result.get("message", "OCR failed"))
        
        print(json.dumps(result), flush=True)

    except Exception as e:
        logger.critical(f"OCR command failed: {e}", exc_info=True)
        print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        sys.exit(1)


def run_upscale_command(args):
    """Handles the upscale task."""
    logger = logging.getLogger("dvr_scan")
    try:
        import shutil
        import subprocess
        import sys
        from pathlib import Path
        
        # Get paths relative to the executable location (for bundled app) or script location (for development)
        exe_dir = Path(sys.executable).parent
        script_dir = exe_dir / "upscayl-cli"
        
        # Fallback for development
        if not script_dir.exists():
            script_dir = Path(__file__).parent.parent / "upscayl-cli"
        
        if not script_dir.exists():
            raise FileNotFoundError(f"Upscayl CLI directory not found at: {script_dir}")
        
        # Define paths
        bin_dir = script_dir / "bin"
        executable_path = bin_dir / ("upscayl-bin.exe" if sys.platform == "win32" else "upscayl-bin")
        models_dir = exe_dir / "models" / "upscayl"
        
        # Fallback for development
        if not models_dir.exists():
            models_dir = Path(__file__).parent.parent / "models" / "upscayl"
        
        if not executable_path.exists():
            raise FileNotFoundError(f"Upscayl executable not found at: {executable_path}")
        
        if not models_dir.exists():
            raise FileNotFoundError(f"Upscayl models directory not found at: {models_dir}")
        
        logger.info(f"Starting upscaling for image: {args.image} with model: {args.model}")
        
        # Validate input file
        input_path = Path(args.image).resolve()
        if not input_path.is_file():
            raise FileNotFoundError(f"Input file not found: {input_path}")
        
        # Validate model files
        model_param = models_dir / f"{args.model}.param"
        model_bin = models_dir / f"{args.model}.bin"
        
        if not model_param.exists() or not model_bin.exists():
            available_models = [p.stem for p in models_dir.glob("*.param")]
            raise FileNotFoundError(f"Model '{args.model}' not found. Available models: {available_models}")
        
        # Determine output path
        if args.output:
            output_path = Path(args.output).resolve()
        else:
            base_name = input_path.stem
            output_dir = script_dir / "output"
            output_dir.mkdir(exist_ok=True)
            output_path = output_dir / f"{base_name}_{args.model}_upscaled.png"
        
        # Create temporary working directory in system temp folder
        import tempfile
        temp_base = Path(tempfile.gettempdir()) / "niriksha_upscayl"
        temp_base.mkdir(exist_ok=True)
        temp_work_dir = temp_base / f"work_{hash(args.model + str(input_path))}"
        temp_work_dir.mkdir(exist_ok=True)
        temp_models_dir = temp_work_dir / "models"
        temp_models_dir.mkdir(exist_ok=True)
        
        # Copy executable and model files to temporary location
        temp_executable = temp_work_dir / executable_path.name
        shutil.copy2(executable_path, temp_executable)
        
        try:
            # Copy model files to temporary models directory
            shutil.copy2(model_param, temp_models_dir)
            shutil.copy2(model_bin, temp_models_dir)
            
            print("Processing...")
            
            # Build command using temp executable
            command = [
                str(temp_executable),
                "-i", str(input_path),
                "-o", str(output_path),
                "-n", args.model,
                "-f", "png"
            ]
            
            # Run the upscaling from temp directory
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=True,
                cwd=temp_work_dir  # Run from temp working directory
            )
            
            # Print output
            if process.stdout:
                print(process.stdout)
            if process.stderr:
                print(process.stderr)
            
            print(f"[SUCCESS] Done! Saved to '{output_path}'")
            
            # Return success
            print(json.dumps({
                "type": "upscale_complete",
                "success": True,
                "input_image": str(args.image),
                "model": args.model,
                "output_path": str(output_path)
            }), flush=True)
            
        finally:
            # Clean up temporary files
            if temp_work_dir.exists():
                print("Cleaning up temporary files...")
                shutil.rmtree(temp_work_dir)
        
    except subprocess.CalledProcessError as e:
        error_msg = f"Upscaling process failed: {e.stderr}"
        logger.error(error_msg)
        print(json.dumps({
            "type": "upscale_error",
            "success": False,
            "error": error_msg,
            "input_image": args.image,
            "model": args.model
        }), flush=True)
    except Exception as e:
        error_msg = f"Upscaling command failed: {str(e)}"
        logger.error(error_msg, exc_info=True)
        print(json.dumps({
            "type": "upscale_error",
            "success": False,
            "error": error_msg,
            "input_image": args.image,
            "model": args.model
        }), flush=True)

def parse_settings():
    """Parse command line options and load config file settings."""
    init_log = []
    failed_to_load_config = True
    debug_mode = False
    config = ConfigRegistry()
    config_load_error = None
    try:
        user_config = ConfigRegistry()
        user_config.load()
        config = user_config
        init_logging(args=None, config=config)
    except ConfigLoadFailure as ex:
        config_load_error = ex

    try:
        args = get_cli_parser(config).parse_args()
        if hasattr(args, 'ignore_user_config') and args.ignore_user_config:
            config_load_error = None
            config = ConfigRegistry()
        debug_mode = hasattr(args, 'debug') and args.debug
        init_logging(args=args, config=config)
        init_log += [(logging.INFO, "DVR-Scan %s" % dvr_scan.__version__)]
        if config_load_error and not hasattr(args, "config"):
            raise config_load_error
        if debug_mode:
            init_log += config.consume_init_log()
        if hasattr(args, "config") and args.config is not None:
            config_setting = ConfigRegistry()
            config_setting.load(Path(args.config))
            init_logging(args, config_setting)
            config = config_setting
        init_log += config.consume_init_log()
        if config.get("save-log"):
            setup_logger(
                logfile_path=LOGFILE_PATH,
                max_log_files=config.get("max-log-files"),
                name_prefix="dvr-scan",
            )
        failed_to_load_config = False
    except ConfigLoadFailure as ex:
        failed_to_load_config = True
        config_load_error = ex
        init_log += ex.init_log
        if ex.reason is not None:
            init_log += [(logging.ERROR, "Error: %s" % str(ex.reason).replace("\t", "  "))]
    finally:
        for log_level, log_str in init_log:
            logger.log(log_level, log_str)

    if failed_to_load_config:
        logger.critical("Failed to load config file.")
        logger.debug("Error loading config file:", exc_info=config_load_error)
        if debug_mode:
            raise config_load_error
        return None

    if config.config_dict:
        logger.debug("Loaded configuration:\n%s", str(config.config_dict))

    if args.command == 'scan':
        validated, args = _preprocess_args(args)
        if not validated:
            return None

    logger.debug("Program arguments:\n%s", str(args))
    settings = ScanSettings(args=args, config=config)

    if args.command == 'scan':
        try:
            detector_type = settings.get("bg-subtractor")
            bg_subtractor = DetectorType[detector_type.upper()]
        except KeyError:
            logger.error("Error: Unknown background subtraction type: %s", detector_type)
            return None
        if not bg_subtractor.value.is_available():
            if bg_subtractor == DetectorType.MOG2_CUDA:
                logger.error("MOG2_CUDA requires a CUDA-enabled build of the `opencv-python` package!")
            else:
                logger.error(
                    f"Method {bg_subtractor.name} is not available, you may need to run: "
                    "`pip install opencv-contrib-python`"
                )
            return None

    return settings

def _preprocess_args(args):
    """Perform preprocessing and validation of command line arguments."""
    if hasattr(args, 'input') and args.input:
        processed_inputs: ty.List[str] = []
        for input_val in args.input:
            if isinstance(input_val, list):
                processed_inputs.extend(input_val)
            else:
                processed_inputs.append(input_val)
        args.input = processed_inputs
    return True, args

# ============================================================
# COMMAND IMPLEMENTATIONS
# ============================================================

def run_dvr_scan(settings):
    """Run DVR-Scan motion detection logic using validated settings."""
    scanner = init_scanner(settings)
    result = scanner.scan()
    if result is None:
        logger.info("Scan cancelled by user.")
        print(json.dumps({"type": "scan_cancelled"}), flush=True)
        return
        
    event_list = result.event_list
    if not event_list:
        logger.info("No motion events detected in input.")
        print(json.dumps({"type": "complete", "events": []}), flush=True)
    else:
        logger.info("Detected %d motion events in input.", len(event_list))
        events_json = [
            {
                "event": i + 1,
                "start": event.start.get_timecode(),
                "end": event.end.get_timecode(),
                "duration": (event.end - event.start).get_timecode(),
            }
            for i, event in enumerate(event_list)
        ]
        print(json.dumps({"type": "complete", "events": events_json}), flush=True)


def run_criminal_detection_command(args):
    """Router for criminal-detection subcommands with lazy imports."""
    try:
        # LAZY IMPORT: Import only when needed
        from criminal_detection import main_cli as criminal_detection_cli
        logger.info(f"Executing criminal detection task: {args.subcommand}")
        output_path = criminal_detection_cli.run_task(args)
        event = {"type": "criminal_detection_complete", "success": True, "task": args.subcommand}
        if output_path:
            event["output_path"] = output_path
        print(json.dumps(event), flush=True)
    except Exception as e:
        logger.error(f"Criminal detection failed: {str(e)}", exc_info=True)
        print(json.dumps({"type": "criminal_detection_error", "success": False, "error": str(e)}), flush=True)


def run_object_detection_command(args):
    """Router for object-detection subcommands with lazy imports."""
    try:
        # LAZY IMPORT: Import only when needed
        from object_detection import inference as object_detection_cli
        logger.info("Executing object detection task.")
        sidecar = object_detection_cli.run_video_detection(args.weights, args.model, args.video, args.output)
        print(json.dumps({"type": "object_detection_complete", "success": True, "output_path": args.output,
                          "detections_path": sidecar}), flush=True)
    except Exception as e:
        logger.error(f"Object detection failed: {str(e)}", exc_info=True)
        print(json.dumps({"type": "object_detection_error", "success": False, "error": str(e)}), flush=True)

def _find_h264_start_code(reader, block_start_addr, search_limit=8192):
    """
    Searches the beginning of a data block for the first H.264 start code (00 00 00 01).
    This is crucial because SPS/PPS headers often precede the first frame data.
    """
    try:
        chunk = reader.read(block_start_addr, search_limit)
        # The nal_unit_start_code is the universal start for any H264 packet
        nal_unit_start_code = b'\x00\x00\x00\x01'
        position = chunk.find(nal_unit_start_code)

        if position != -1:
            true_start = block_start_addr + position
            logging.info(f"  Found H.264 start code at {hex(true_start)}, stream headers are likely present.")
            return true_start
    except Exception as e:
        logging.warning(f"  Could not search for start code: {e}")
    
    # Fallback if no start code is found in the search limit
    logging.warning(f"  No H.264 start code found near block start. Falling back to block_start_addr.")
    return block_start_addr

def run_hikvision_convert_command(args):
    """
    Handles on-demand indexing, conversion to MP4, and returns the path.
    """
    reader = None
    try:
        from dvr_scan.hikvision.helpers import ImageReader
        from dvr_scan.hikvision.idr_parser import IdrParser
        import subprocess
        import tempfile

        reader = ImageReader(args.image)
        if not reader.open():
            sys.exit(1)
            
        idr_parser = IdrParser(reader)

        with open(args.master_file, 'r') as f:
            master_data = json.load(f)['master_sector']
        block_size = master_data['data_block_size']['value']
        
        block_start_addr = int(args.offset, 0) + args.extra_offset
        idr_records = idr_parser.parse_single_data_block(block_start_addr, block_size)

        if not idr_records or len(idr_records) < 2:
            raise Exception(f"Block {args.offset} has insufficient frames for conversion.")

        # --- FIX: Correctly determine video boundaries ---
        # 1. Find the true start of the H264 stream, which contains the critical SPS/PPS headers.
        true_video_start_addr = _find_h264_start_code(reader, block_start_addr)

        # 2. Find the end of the last frame's data.
        all_addresses = [r['address'] for r in idr_records]
        video_end_addr = max(all_addresses) + 56 # Add record size as a safe buffer

        # 3. The final video data starts at the true stream start and ends after the last frame.
        video_start_addr = true_video_start_addr
        video_size_bytes = video_end_addr - video_start_addr
        # --- END OF FIX ---

        if video_size_bytes <= 0:
            raise Exception(f"Invalid video parameters: calculated size is {video_size_bytes} bytes.")

        # 2. Convert to MP4
        temp_dir = tempfile.gettempdir()
        # Use a more descriptive temp file name
        safe_offset_str = args.offset.replace('0x', '')
        temp_path = os.path.join(temp_dir, f'niriksha_{safe_offset_str}_{os.getpid()}.mp4')

        logging.info(f"  Carving {video_size_bytes / 1024**2:.2f} MB from {hex(video_start_addr)} to {hex(video_end_addr)}")
        raw_data = reader.read(video_start_addr, video_size_bytes)
        
        ffmpeg_cmd = [
            'ffmpeg', '-y', '-loglevel', 'warning', '-f', 'h264',
            '-i', 'pipe:0', '-c:v', 'copy', '-an',
            '-movflags', '+faststart', '-f', 'mp4', temp_path
        ]
        
        proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _, stderr = proc.communicate(input=raw_data)
        
        if proc.returncode != 0:
            error_msg = stderr.decode('utf-8', errors='ignore')
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            raise Exception(f"FFmpeg conversion failed: {error_msg}")

        # 3. Return result as JSON
        idr_records.sort(key=lambda r: r['timestamp_unix'])
        result = {
            "type": "hik_convert_complete",
            "success": True,
            "mp4_path": temp_path,
            "offset": args.offset,
            "seek_timestamp": args.seek_timestamp,
            "start_time": idr_records[0]['timestamp_unix'],
            "idr_frames": [r['timestamp_unix'] for r in idr_records]
        }
        print(json.dumps(result), flush=True)

    except Exception as e:
        logger.error(f"Hikvision convert command failed: {str(e)}", exc_info=True)
        print(json.dumps({"type": "hik_error", "success": False, "error": str(e)}), flush=True)
    finally:
        if reader:
            reader.close()

def run_hikvision_command(args):
    """Router for all hikvision subcommands with lazy imports."""
    try:
        # LAZY IMPORTS: Import only when needed
        from dvr_scan.hikvision.helpers import ImageReader
        from dvr_scan.hikvision.master_sector import MasterSectorParser
        from dvr_scan.hikvision.hikbtree import HikbtreeParser
        from dvr_scan.hikvision.system_logs import SystemLogParser
        from dvr_scan.hikvision.extractor import VideoExtractor

        # Define internal functions for each subcommand
        def run_master_parser_internal(args):
            reader = None
            try:
                reader = ImageReader(args.image)
                if not reader.open(): sys.exit(1)
                parser = MasterSectorParser(reader)
                extra_offset = parser.run_parser(args.output_file)
                if extra_offset is not None:
                    print(json.dumps({"type": "hik_master_complete", "success": True, "output_file": args.output_file, "extra_offset": extra_offset}), flush=True)
                else:
                    raise Exception("Master sector parsing failed.")
            finally:
                if reader: reader.close()

        def run_hikbtree_parser_internal(args):
            reader = None
            try:
                reader = ImageReader(args.image)
                if not reader.open(): sys.exit(1)
                parser = HikbtreeParser(reader)
                success = parser.run_parser(args.master_file, args.output_file, args.extra_offset)
                if success:
                    print(json.dumps({"type": "hik_hikbtree_complete", "success": True, "output_file": args.output_file}), flush=True)
                else:
                    raise Exception("HIKBTREE parsing failed.")
            finally:
                if reader: reader.close()

        def run_system_logs_parser_internal(args):
            reader = None
            try:
                reader = ImageReader(args.image)
                if not reader.open(): sys.exit(1)
                parser = SystemLogParser(reader)
                success = parser.run_parser(args.master_file, args.output_file, args.extra_offset)
                if success:
                    print(json.dumps({"type": "hik_logs_complete", "success": True, "output_file": args.output_file}), flush=True)
                else:
                    raise Exception("System log parsing failed.")
            finally:
                if reader: reader.close()
        
        def run_video_extractor_internal(args):
            reader = None
            try:
                reader = ImageReader(args.image)
                if not reader.open(): sys.exit(1)
                extractor = VideoExtractor(reader, output_dir=args.output_dir)
                success, filepath = extractor.extract_single_block(args.offset, args.master_file, args.extra_offset)
                if success:
                    print(json.dumps({"type": "hik_extract_complete", "path": filepath, "success": True}), flush=True)
                else:
                    raise Exception("Video extraction failed.")
            finally:
                if reader: reader.close()

        def run_parse_all_internal(args):
            reader = None
            try:
                reader = ImageReader(args.image)
                if not reader.open(): sys.exit(1)
                output_dir = args.output_dir or os.getcwd()
                os.makedirs(output_dir, exist_ok=True)
                master_file = os.path.join(output_dir, "master_sector.json")
                hikbtree_file = os.path.join(output_dir, "hikbtree.json")
                logs_file = os.path.join(output_dir, "system_logs.json")

                print(json.dumps({"type": "hik_progress", "step": "master", "message": "Starting master sector parsing..."}), flush=True)
                parser_master = MasterSectorParser(reader)
                extra_offset = parser_master.run_parser(master_file)
                if extra_offset is None: raise Exception("Master sector parsing failed.")
                print(json.dumps({"type": "hik_progress", "step": "master", "message": f"✓ Master sector parsed. Extra offset: {extra_offset}"}), flush=True)

                print(json.dumps({"type": "hik_progress", "step": "hikbtree", "message": "Starting HIKBTREE parsing..."}), flush=True)
                parser_hikbtree = HikbtreeParser(reader)
                if not parser_hikbtree.run_parser(master_file, hikbtree_file, extra_offset): raise Exception("HIKBTREE parsing failed.")
                print(json.dumps({"type": "hik_progress", "step": "hikbtree", "message": "✓ HIKBTREE parsed successfully."}), flush=True)

                print(json.dumps({"type": "hik_progress", "step": "logs", "message": "Starting system logs parsing..."}), flush=True)
                parser_logs = SystemLogParser(reader)
                if not parser_logs.run_parser(master_file, logs_file, extra_offset): raise Exception("System log parsing failed.")
                print(json.dumps({"type": "hik_progress", "step": "logs", "message": "✓ System logs parsed successfully."}), flush=True)

                print(json.dumps({
                    "type": "hik_parse_all_complete", "success": True,
                    "files": {"master": master_file, "hikbtree": hikbtree_file, "logs": logs_file},
                    "image_id": args.image_id, "extra_offset": extra_offset
                }), flush=True)
            finally:
                if reader: reader.close()

        # Main routing logic for the 'hikvision' command
        if args.subcommand == "master":
            run_master_parser_internal(args)
        elif args.subcommand == "hikbtree":
            run_hikbtree_parser_internal(args)
        elif args.subcommand == "logs":
            run_system_logs_parser_internal(args)
        elif args.subcommand == "parse-all":
            run_parse_all_internal(args)
        elif args.subcommand == "extract":
            run_video_extractor_internal(args)
        elif args.subcommand == "convert":
            run_hikvision_convert_command(args)
    except Exception as e:
        logger.error(f"Hikvision command failed: {str(e)}", exc_info=True)
        print(json.dumps({"type": "hik_error", "success": False, "error": str(e)}), flush=True)
