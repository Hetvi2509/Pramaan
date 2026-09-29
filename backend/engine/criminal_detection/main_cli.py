# dvr-scan-py/criminal_detection/main_cli.py

import argparse
import os
import logging

logger = logging.getLogger("criminal_detection")

def run_task(args):
    """Callable function to run criminal detection tasks. Returns the annotated video
    path for "index" (its one visual output), or None for subcommands that don't
    produce one — callers use this to report where their output actually landed,
    instead of the caller guessing from whatever else is in the output directory."""
    try:
        # LAZY IMPORT: Only import when function is called
        from . import face_utils
    except ImportError as e:
        logger.error(f"Failed to import face_utils: {e}")
        raise RuntimeError("Criminal detection module could not be loaded") from e
    except RuntimeError as e:
        logger.error(f"Face recognition models not available: {e}")
        raise RuntimeError("Face recognition models are not available. Please ensure face_recognition_models is properly installed.") from e

    if args.subcommand == "index":
        try:
            temp_face_folder = os.path.join(args.output_dir, "temp_faces")
            encodings_file = os.path.join(args.output_dir, "encodings.pkl")
            video_filename = os.path.splitext(os.path.basename(args.video_path))[0]
            annotated_output_path = os.path.join(args.output_dir, f"{video_filename}_faces.mp4")

            logger.info(f"Starting face indexing from video: {args.video_path}")
            print(f"Starting face indexing from video: {args.video_path}")

            # Step 1: Extract faces from the source video, and write the annotated video alongside it
            face_utils.extract_faces_from_video(args.video_path, temp_face_folder, annotated_output_path=annotated_output_path)

            # Step 2: Cluster and save the encodings of the unique faces
            face_utils.cluster_and_encode_faces(temp_face_folder, encodings_file)

            # Clean up temporary face images
            if os.path.exists(temp_face_folder):
                for file_name in os.listdir(temp_face_folder):
                    os.remove(os.path.join(temp_face_folder, file_name))
                os.rmdir(temp_face_folder)

            logger.info("Face indexing completed successfully")
            print("Face indexing completed successfully")
            return annotated_output_path
        except Exception as e:
            logger.error(f"Error during face indexing: {e}", exc_info=True)
            raise

    elif args.subcommand == "recognize":
        try:
            encodings_file = os.path.join(args.index_dir, "encodings.pkl")
            if not os.path.exists(encodings_file):
                logger.error(f"Encodings file not found at {encodings_file}")
                raise FileNotFoundError(f"Encodings file not found. Please run 'index' command first.")
            
            if not os.path.exists(args.output_dir):
                os.makedirs(args.output_dir)
            
            video_filename = os.path.splitext(os.path.basename(args.video_path))[0]
            output_csv = os.path.join(args.output_dir, f"{video_filename}_detections.csv")

            logger.info(f"Starting face recognition in video: {args.video_path}")
            print(f"Starting face recognition in video: {args.video_path}")
            
            face_utils.recognize_faces_in_video(args.video_path, encodings_file, output_csv)
            
            logger.info(f"Face recognition completed. Results saved to {output_csv}")
            print(f"Face recognition completed. Results saved to {output_csv}")
        except Exception as e:
            logger.error(f"Error during face recognition: {e}", exc_info=True)
            raise


def main():
    parser = argparse.ArgumentParser(description="Facial Recognition CLI Tool for Crime Detection.")
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    parser_index = subparsers.add_parser("index", help="Index faces from a source video.")
    parser_index.add_argument("video_path", type=str, help="Path to the video file to index.")
    parser_index.add_argument("--output-dir", type=str, default="known_faces", help="Directory to save indexed face data.")
    
    parser_recognize = subparsers.add_parser("recognize", help="Recognize faces in a target video.")
    parser_recognize.add_argument("video_path", type=str, help="Path to the video file for recognition.")
    parser_recognize.add_argument("--index-dir", type=str, default="known_faces", help="Directory where indexed face data is stored.")
    parser_recognize.add_argument("--output-dir", type=str, default="output", help="Directory to save the output CSV file.")

    args = parser.parse_args()

    if args.command:
        # We map the argparse Namespace to a new one for run_task
        task_args = argparse.Namespace(
            subcommand=args.command,
            video_path=args.video_path,
            output_dir=getattr(args, 'output_dir', None),
            index_dir=getattr(args, 'index_dir', None)
        )
        run_task(task_args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()