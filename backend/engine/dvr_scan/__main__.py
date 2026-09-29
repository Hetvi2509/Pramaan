#
# dvr_scan.__main__ Module
#

import logging
import sys
from subprocess import CalledProcessError

from scenedetect import VideoOpenFailure

# CORRECTED: Only import what is needed at the top level for all commands
from dvr_scan.controller import parse_settings
from dvr_scan.shared import logging_redirect_tqdm

EXIT_SUCCESS: int = 0
EXIT_ERROR: int = 1

def main():
    """Main entry-point for DVR-Scan."""
    settings = parse_settings()
    if settings is None:
        sys.exit(EXIT_ERROR)
    
    logger = logging.getLogger("dvr_scan")
    # Get the top-level command ('scan', 'hikvision', etc.)
    command_to_run = settings.get_arg(None).command

    def main_impl():
        debug_mode = settings.get("debug")
        show_traceback = getattr(logging, settings.get("verbosity").upper()) == logging.DEBUG
        try:
            # LAZY IMPORTS: Import the required function just before it is used
            if command_to_run == "scan":
                from dvr_scan.controller import run_dvr_scan
                run_dvr_scan(settings)
            elif command_to_run == "hikvision":
                from dvr_scan.controller import run_hikvision_command
                run_hikvision_command(settings.get_arg(None))
            elif command_to_run == "criminal-detection":
                from dvr_scan.controller import run_criminal_detection_command
                run_criminal_detection_command(settings.get_arg(None))
            elif command_to_run == "object-detection":
                from dvr_scan.controller import run_object_detection_command
                run_object_detection_command(settings.get_arg(None))
            elif command_to_run == "ocr": # ADD THIS BLOCK
                from dvr_scan.controller import run_ocr_command
                run_ocr_command(settings)
            elif command_to_run == "upscale": # ADD THIS BLOCK
                from dvr_scan.controller import run_upscale_command
                run_upscale_command(settings.get_arg(None))
            else:
                logger.error(f"Unknown command: {command_to_run}")
                sys.exit(EXIT_ERROR)
        except ValueError as ex:
            logger.critical("Setting Error: %s", str(ex), exc_info=show_traceback)
            if debug_mode: raise
        except (VideoOpenFailure, FileNotFoundError) as ex:
            logger.critical("Failed to load input: %s", str(ex), exc_info=show_traceback)
            if debug_mode: raise
        except KeyboardInterrupt:
            logger.info("Stopping (interrupt received)...", exc_info=show_traceback)
            if debug_mode: raise
        except CalledProcessError as ex:
            logger.error(
                "Failed to run command:\n  %s\nCommand returned %d, output:\n\n%s",
                " ".join(ex.cmd), ex.returncode, ex.output, exc_info=show_traceback,
            )
            if debug_mode: raise
        except NotImplementedError as ex:
            logger.critical("Error (Not Implemented): %s", str(ex), exc_info=show_traceback)
            if debug_mode: raise
        except Exception as ex:
            logger.critical("Critical Error: %s", str(ex), exc_info=True)
            if debug_mode: raise
        else:
            sys.exit(EXIT_SUCCESS)
        sys.exit(EXIT_ERROR)

    # quiet_mode is only a valid argument for the 'scan' command
    quiet_mode = hasattr(settings.get_arg(None), 'quiet_mode') and settings.get_arg(None).quiet_mode
    if quiet_mode:
        main_impl()
    else:
        with logging_redirect_tqdm(loggers=[logger]):
            main_impl()

if __name__ == "__main__":
    main()