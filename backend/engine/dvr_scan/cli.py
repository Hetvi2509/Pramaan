import argparse
import typing as ty

from dvr_scan.config import CHOICE_MAP, USER_CONFIG_FILE_PATH, ConfigRegistry
from dvr_scan.platform_utils import HAS_MOG2_CUDA
from dvr_scan.region import RegionValidator
from dvr_scan.shared import logfile_path
from dvr_scan.shared.cli import (
    VERSION_STRING,
    LicenseAction,
    VersionAction,
    float_type_check,
    int_type_check,
    kernel_size_type_check,
    string_type_check,
    timecode_type_check,
)


SCAN_ONLY_MODE = "scan_only"
assert SCAN_ONLY_MODE in CHOICE_MAP["output-mode"]

VALID_OUTPUT_MODES = [mode for mode in CHOICE_MAP["output-mode"] if mode != SCAN_ONLY_MODE]

BACKGROUND_SUBTRACTORS = ["MOG2", "CNT", "MOG2_CUDA"] if HAS_MOG2_CUDA else ["MOG2", "CNT"]


LOGFILE_PATH = logfile_path(name_prefix="dvr-scan")


class RegionAction(argparse.Action):
    DEFAULT_ERROR_MESSAGE = "Region must be 3 or more points of the form X0 Y0 X1 Y1 X2 Y2 ..."

    def __init__(
        self,
        option_strings,
        dest,
        nargs=None,
        const=None,
        default=None,
        type=None,
        choices=None,
        required=False,
        help=None,
        metavar=None,
    ):
        assert nargs == "*"
        assert const is None
        super(RegionAction, self).__init__(
            option_strings=option_strings,
            dest=dest,
            nargs=nargs,
            const=const,
            default=default,
            type=type,
            choices=choices,
            required=required,
            help=help,
            metavar=metavar,
        )

    def __call__(self, parser, namespace, values: ty.List[str], option_string=None):
        try:
            region = RegionValidator(" ".join(values))
        except ValueError as ex:
            message = " ".join(str(arg) for arg in ex.args)
            raise (
                argparse.ArgumentError(
                    self, message if message else self.DEFAULT_ERROR_MESSAGE
                )
            ) from ex

        items = getattr(namespace, self.dest, [])
        items += [region.value]
        setattr(namespace, self.dest, items)


def get_cli_parser(user_config: ConfigRegistry):
    """Creates the DVR-Scan argparse command-line interface with subcommands."""

    parser = argparse.ArgumentParser(
        description="DVR-Scan: A tool for video motion detection and DVR image extraction.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        exit_on_error=not user_config.get("debug"),
    )

    # ===================================================================
    #   Global Arguments (apply to all commands)
    # ===================================================================
    parser.add_argument(
        "-V", "--version", action=VersionAction, version=VERSION_STRING
    )
    parser.add_argument(
        "--debug", action="store_true", help=argparse.SUPPRESS, default=False
    )
    parser.add_argument(
        "--ignore-user-config",
        action="store_true",
        default=False,
        help="Ignore loading the user config file if present.",
    )
    parser.add_argument(
        "--json-output",
        action="store_true",
        help=argparse.SUPPRESS,
        default=False,
    )

    # --- Create Sub-parsers for 'scan' and 'hikvision' commands ---
    subparsers = parser.add_subparsers(
        dest="command", required=True, help="Available commands"
    )

    # ===================================================================
    #   SCAN command parser
    # ===================================================================
    parser_scan = subparsers.add_parser(
        "scan",
        help="Scan video files for motion events.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        argument_default=argparse.SUPPRESS,
    )

    if hasattr(parser_scan, "_optionals"):
        parser_scan._optionals.title = "scan arguments"

    parser_scan.add_argument(
        "-i", "--input", metavar="video_file", required=True, type=str, nargs="+", action="append",
        help="[REQUIRED] Path to input video(s) or glob pattern.",
    )
    parser_scan.add_argument(
        "-d", "--output-dir", metavar="path", type=str, help="Directory to write output files."
    )
    parser_scan.add_argument(
        "-o", "--output", metavar="video.avi", type=str,
        help="Concatenate all motion events into a single output file (OpenCV mode only).",
    )
    parser_scan.add_argument(
        "-m", "--output-mode", metavar="mode", type=string_type_check(VALID_OUTPUT_MODES, False, "mode"),
        help=f"Mode for generating output files: {', '.join(VALID_OUTPUT_MODES)}."
             f"{user_config.get_help_string('output-mode')}",
    )
    parser_scan.add_argument(
        "-so", "--scan-only", action="store_true", default=False,
        help="Only perform motion detection, do not write any video files to disk.",
    )
    parser_scan.add_argument(
        "-c", "--config", metavar="settings.cfg", type=str,
        help=f"Path to config file. Default search path: {USER_CONFIG_FILE_PATH}",
    )
    parser_scan.add_argument(
        "-r", "--region-editor", dest="region_editor", action="store_true",
        help="Show interactive region editor window to define motion detection areas.",
    )
    parser_scan.add_argument(
        "-a", "--add-region", metavar="X0 Y0 ...", dest="regions", nargs="*", action=RegionAction,
        help="Define a polygonal region for motion detection via coordinates.",
    )
    parser_scan.add_argument(
        "-R", "--load-region", metavar="REGIONS.txt", type=str, help="Load region data from a file."
    )
    parser_scan.add_argument(
        "-s", "--save-region", metavar="REGIONS.txt", type=str, help="Save region data to a file."
    )
    MOG2_CUDA = ", MOG2_CUDA (Nvidia GPU)" if HAS_MOG2_CUDA else ""
    parser_scan.add_argument(
        "-b", "--bg-subtractor", metavar="type", type=string_type_check(BACKGROUND_SUBTRACTORS, False, "type"),
        help=f"Background subtractor to use: MOG2 (default), CNT, or MOG2_CUDA (if available)."
             f"{user_config.get_help_string('bg-subtractor')}",
    )
    parser_scan.add_argument(
        "-t", "--threshold", metavar="value", type=float_type_check(0.0, None, "value"),
        help=f"Motion detection threshold (lower is more sensitive)."
             f"{user_config.get_help_string('threshold')}",
    )
    parser_scan.add_argument(
        "-k", "--kernel-size", metavar="size", type=kernel_size_type_check(metavar="size"),
        help=f"Noise reduction kernel size.{user_config.get_help_string('kernel-size')}"
    )
    parser_scan.add_argument(
        "-l", "--min-event-length", metavar="time", type=timecode_type_check("time"),
        help=f"Minimum length of a motion event.{user_config.get_help_string('min-event-length')}"
    )
    parser_scan.add_argument(
        "-tb", "--time-before-event", metavar="time", type=timecode_type_check("time"),
        help=f"Time to include before a motion event.{user_config.get_help_string('time-before-event')}"
    )
    parser_scan.add_argument(
        "-tp", "--time-post-event", metavar="time", type=timecode_type_check("time"),
        help=f"Time to include after a motion event.{user_config.get_help_string('time-post-event')}"
    )
    parser_scan.add_argument(
        "-st", "--start-time", metavar="time", type=timecode_type_check("time"),
        help="Time to start processing video from."
    )
    parser_scan.add_argument(
        "-dt", "--duration", metavar="time", type=timecode_type_check("time"),
        help="Maximum duration of video to process."
    )
    parser_scan.add_argument(
        "-et", "--end-time", metavar="time", type=timecode_type_check("time"),
        help="Time to stop processing video at."
    )
    parser_scan.add_argument(
        "-roi", "--region-of-interest", dest="region_of_interest", metavar="x0 y0 w h", nargs="*",
        help=argparse.SUPPRESS
    )
    parser_scan.add_argument(
        "-bb", "--bounding-box", metavar="smooth_time", type=timecode_type_check("smooth_time"), nargs="?", const=True,
        help=f"Draw bounding box around motion.{user_config.get_help_string('bounding-box', show_default=False)}"
    )
    parser_scan.add_argument(
        "-tc", "--time-code", action="store_true",
        help=f"Draw time code on frames.{user_config.get_help_string('time-code', show_default=False)}"
    )
    parser_scan.add_argument(
        "-fm", "--frame-metrics", action="store_true",
        help=f"Draw frame metrics on frames.{user_config.get_help_string('frame-metrics', show_default=False)}"
    )
    parser_scan.add_argument(
        "-mo", "--mask-output", metavar="motion_mask.avi", type=str,
        help="Save motion mask video for tuning."
    )
    parser_scan.add_argument(
        "-df", "--downscale-factor", metavar="factor", type=int_type_check(0, None, "factor"),
        help=f"Factor to downscale video for performance.{user_config.get_help_string('downscale-factor')}"
    )
    parser_scan.add_argument(
        "-fs", "--frame-skip", metavar="num_frames", type=int_type_check(0, None, "num_frames"),
        help=f"Number of frames to skip between processing.{user_config.get_help_string('frame-skip')}"
    )
    parser_scan.add_argument(
        "-q", "--quiet", dest="quiet_mode", action="store_true",
        help=f"Suppress all console output except final results.{user_config.get_help_string('quiet-mode')}"
    )
    parser_scan.add_argument(
        "--logfile", metavar="file", type=str,
        help=f"Append application output to file. Log path: {LOGFILE_PATH.parent}"
    )
    parser_scan.add_argument(
        "--thumbnails", metavar="method", type=str, default=None, help="Produce event thumbnail(s)."
    )
    parser_scan.add_argument(
        "-v", "--verbosity", metavar="type", type=string_type_check(CHOICE_MAP["verbosity"], False, "type"),
        help=f"Log output verbosity: {', '.join(CHOICE_MAP['verbosity'])}.{user_config.get_help_string('verbosity')}"
    )
    parser_scan.add_argument(
        "--use-pts", action="store_true", default=False,
        help="Use presentation timestamps instead of frame numbers."
    )

    # ===================================================================
    #   HIKVISION command parser
    # ===================================================================
    parser_hik = subparsers.add_parser(
        "hikvision",
        help="Tools for parsing and extracting data from Hikvision DVR disk images.",
    )
    hik_subparsers = parser_hik.add_subparsers(dest="subcommand", required=True, help="Hikvision tools")

    # --- HIKVISION MASTER ---
    parser_master = hik_subparsers.add_parser("master", help="Parse the master sector from a disk image.")
    parser_master.add_argument("--image", required=True, help="Path to the disk image file (.dd, .E01, etc.).")
    parser_master.add_argument("-o", "--output-file", required=True, help="Path to save the master_sector.json output file.")

    # --- HIKVISION HIKBTREE ---
    parser_hikbtree = hik_subparsers.add_parser("hikbtree", help="Parse the HIKBTREE file index from a disk image.")
    parser_hikbtree.add_argument("--image", required=True, help="Path to the disk image file.")
    parser_hikbtree.add_argument("--master-file", required=True, help="Path to the master_sector.json file generated by the 'master' command.")
    parser_hikbtree.add_argument("--extra-offset", type=int, default=0, help="Extra offset value from master sector parsing.")
    parser_hikbtree.add_argument("-o", "--output-file", required=True, help="Path to save the hikbtree.json output file.")
    
    # --- HIKVISION LOGS ---
    parser_logs = hik_subparsers.add_parser("logs", help="Parse the system logs from a disk image.")
    parser_logs.add_argument("--image", required=True, help="Path to the disk image file.")
    parser_logs.add_argument("--master-file", required=True, help="Path to the master_sector.json file.")
    parser_logs.add_argument("--extra-offset", type=int, default=0, help="Extra offset value from master sector parsing.")
    parser_logs.add_argument("-o", "--output-file", required=True, help="Path to save the system_logs.json output file.")

    # --- HIKVISION EXTRACT ---
    parser_extract = hik_subparsers.add_parser("extract", help="Extract a single video block from a disk image.")
    parser_extract.add_argument("--image", required=True, help="Path to the disk image file.")
    parser_extract.add_argument("--master-file", required=True, help="Path to the master_sector.json file.")
    parser_extract.add_argument("--offset", required=True, help="The hex offset of the data block to extract (e.g., '0xfc4c5e000').")
    parser_extract.add_argument("-d", "--output-dir", required=True, help="Directory to save the extracted .h264 file.")
    parser_extract.add_argument("--extra-offset", type=int, default=0, help="Extra offset value from master sector parsing.")

    # --- HIKVISION CONVERT ---
    parser_convert = hik_subparsers.add_parser("convert", help="Convert a raw video block to a streamable MP4 file.")
    parser_convert.add_argument("--image", required=True, help="Path to the disk image file.")
    parser_convert.add_argument("--master-file", required=True, help="Path to the master_sector.json file.")
    parser_convert.add_argument("--offset", required=True, help="The hex offset of the data block to convert.")
    parser_convert.add_argument("--extra-offset", type=int, default=0, help="Extra offset value from master sector parsing.")
    parser_convert.add_argument("--seek-timestamp", type=int, help="Optional Unix timestamp to seek to within the block.")

    # --- HIKVISION PARSE-ALL ---
    parser_parse_all = hik_subparsers.add_parser(
        "parse-all",
        help="Parse all forensic data (master sector, HIKBTREE, and system logs) sequentially."
    )
    parser_parse_all.add_argument(
        "--image",
        required=True,
        help="Path to the disk image file (.dd, .E01, etc.)."
    )
    parser_parse_all.add_argument(
        "-d",
        "--output-dir",
        required=True,
        help="Directory to save all output JSON files (master_sector.json, hikbtree.json, system_logs.json)."
    )
    parser_parse_all.add_argument(
        "--image-id",
        type=int,
        required=True,
        help="The image file ID from the database (used for saving to the database after parsing)."
    )
    
    # ===================================================================
    #   CRIMINAL DETECTION command parser
    # ===================================================================
    parser_criminal = subparsers.add_parser(
        "criminal-detection",
        help="Tools for facial recognition and criminal detection.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    criminal_subparsers = parser_criminal.add_subparsers(dest="subcommand", required=True, help="Criminal detection tasks")

    # --- Criminal Detection Index ---
    parser_cd_index = criminal_subparsers.add_parser("index", help="Index faces from a source video.")
    parser_cd_index.add_argument("video_path", type=str, help="Path to the video file to index.")
    parser_cd_index.add_argument("--output-dir", type=str, required=True, help="Directory to save indexed face data.")

    # --- Criminal Detection Recognize ---
    parser_cd_recognize = criminal_subparsers.add_parser("recognize", help="Recognize faces in a target video.")
    parser_cd_recognize.add_argument("video_path", type=str, help="Path to the video file for recognition.")
    parser_cd_recognize.add_argument("--index-dir", type=str, required=True, help="Directory where indexed face data is stored.")
    parser_cd_recognize.add_argument("--output-dir", type=str, required=True, help="Directory to save the output CSV file.")

    # ===================================================================
    #   OBJECT DETECTION command parser
    # ===================================================================
    parser_object = subparsers.add_parser(
        "object-detection",
        help="Run object detection on a video using RF-DETR model.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser_object.add_argument("--weights", type=str, required=True, help="Path to the local model weights (.pth) file.")
    parser_object.add_argument("--model", type=str, default="base", choices=["nano", "small", "medium", "base"], help="The name of the model architecture.")
    parser_object.add_argument("--video", type=str, required=True, help="Path to the input video file.")
    parser_object.add_argument("--output", type=str, required=True, help="Path to save the output annotated video file.")

    # ===================================================================
    #   OCR command parser
    # ===================================================================
    parser_ocr = subparsers.add_parser(
        "ocr",
        help="Read text from an image or annotate text in a video.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ocr_input = parser_ocr.add_mutually_exclusive_group(required=True)
    ocr_input.add_argument("--video", help="Video to annotate with detected text boxes.")
    parser_ocr.add_argument("--output", help="Annotated video output path.")
    parser_ocr.add_argument("--sample-rate", type=float, default=1.0)
    parser_ocr.add_argument("--confidence", type=float, default=0.8)
    ocr_input.add_argument(
        "--image",
        help="Path to the input image file for OCR processing."
    )

    # ===================================================================
    #   UPSCALE command parser
    # ===================================================================
    parser_upscale = subparsers.add_parser(
        "upscale",
        help="Upscale an image using AI models.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser_upscale.add_argument(
        "--image",
        required=True,
        help="Path to the input image file to upscale."
    )
    parser_upscale.add_argument(
        "--model",
        type=str,
        default="upscayl-lite-4x",
        help="The name of the upscaling model to use (e.g., 'upscayl-lite-4x', 'upscayl-high-fidelity-4x')."
    )
    parser_upscale.add_argument(
        "--output",
        type=str,
        help="Path to save the upscaled image. If not specified, saves to current directory."
    )


    return parser
