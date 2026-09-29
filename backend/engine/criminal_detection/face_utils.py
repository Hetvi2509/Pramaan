# criminal_detection/face_utils.py

import cv2
import pickle
from sklearn.cluster import DBSCAN
import numpy as np
import os
from tqdm import tqdm
import csv
import logging

logger = logging.getLogger("criminal_detection")

# ============================================================================
# CRITICAL: Do NOT import face_recognition here!
# It will be imported lazily inside each function when actually needed.
# This prevents the entire app from crashing at startup if models are missing.
# ============================================================================


def extract_faces_from_video(video_path, output_folder, scale_factor=1.0, annotated_output_path=None):
    """
    Detects and extracts all unique faces from a video file and saves them as images.
    When `annotated_output_path` is given, also writes a full-length copy of the video
    with a box drawn around every detected face, so this step has a visual result to
    show — not just the face crops and encodings used internally for clustering.

    Args:
        video_path (str): The path to the input video file.
        output_folder (str): The directory where face images will be saved.
        scale_factor (float): Factor to scale video frames for faster processing.
        annotated_output_path (str | None): If set, path to write the annotated video to.
    """
    try:
        # LAZY IMPORT: Only import when function is called
        import face_recognition
    except ImportError as e:
        logger.error(f"face_recognition library not available: {e}")
        raise RuntimeError("face_recognition is required for face extraction") from e
    except RuntimeError as e:
        logger.error(f"Failed to load face recognition models: {e}")
        raise RuntimeError("Face recognition models could not be loaded. Ensure face_recognition_models is installed.") from e

    if not os.path.exists(output_folder):
        os.makedirs(output_folder)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        logger.error(f"Could not open video file {video_path}")
        raise ValueError(f"Error: Could not open video file {video_path}")

    writer = None
    if annotated_output_path:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) * scale_factor)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) * scale_factor)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        writer = cv2.VideoWriter(annotated_output_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))

    face_count = 0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    try:
        with tqdm(total=total_frames, desc="Extracting Faces") as pbar:
            while cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    break

                if scale_factor != 1.0:
                    frame = cv2.resize(frame, (0, 0), fx=scale_factor, fy=scale_factor)

                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                face_locations = face_recognition.face_locations(rgb_frame)

                for (top, right, bottom, left) in face_locations:
                    face_img = frame[top:bottom, left:right]
                    face_filename = os.path.join(output_folder, f"{face_count}.jpg")
                    cv2.imwrite(face_filename, face_img)
                    face_count += 1

                if writer is not None:
                    annotated = frame.copy()
                    for (top, right, bottom, left) in face_locations:
                        cv2.rectangle(annotated, (left, top), (right, bottom), (0, 255, 0), 2)
                    writer.write(annotated)

                pbar.update(1)
    finally:
        cap.release()
        if writer is not None:
            writer.release()

    logger.info(f"Extracted {face_count} face instances to {output_folder}")
    print(f"Extracted {face_count} face instances to {output_folder}")


def cluster_and_encode_faces(image_folder, output_encodings_path):
    """
    Loads extracted face images, generates encodings, clusters them to identify
    unique individuals, and saves the encodings.

    Args:
        image_folder (str): The folder containing extracted face images.
        output_encodings_path (str): The file path to save the final encodings pickle file.
    """
    try:
        # LAZY IMPORT: Only import when function is called
        import face_recognition
    except ImportError as e:
        logger.error(f"face_recognition library not available: {e}")
        raise RuntimeError("face_recognition is required for face encoding") from e
    except RuntimeError as e:
        logger.error(f"Failed to load face recognition models: {e}")
        raise RuntimeError("Face recognition models could not be loaded. Ensure face_recognition_models is installed.") from e

    image_paths = [os.path.join(image_folder, f) for f in os.listdir(image_folder)]
    known_encodings = []
    known_names = []

    logger.info("Encoding faces...")
    print("Encoding faces...")
    for image_path in tqdm(image_paths, desc="Encoding"):
        try:
            image = face_recognition.load_image_file(image_path)
            # These images are already tight face crops (saved by extract_faces_from_video),
            # so re-running face detection on them fails: dlib's HOG detector needs margin
            # around a face to find it, and a crop with none returns no locations, so
            # face_encodings() would silently yield zero encodings for every image.
            h, w = image.shape[:2]
            encodings = face_recognition.face_encodings(image, known_face_locations=[(0, w, h, 0)])
            if encodings:
                known_encodings.extend(encodings)
                known_names.extend([image_path] * len(encodings))
        except Exception as e:
            logger.warning(f"Could not process file {image_path}: {e}")
            print(f"Warning: Could not process file {image_path}: {e}")

    if not known_encodings:
        logger.warning("No faces found to encode.")
        print("No faces found to encode.")
        return

    logger.info("Clustering encodings...")
    print("Clustering encodings...")
    clt = DBSCAN(metric="euclidean", n_jobs=-1, eps=0.5)
    clt.fit(known_encodings)

    label_ids = np.unique(clt.labels_)
    num_unique_faces = len(np.where(label_ids > -1)[0])
    logger.info(f"Found {num_unique_faces} unique faces.")
    print(f"Found {num_unique_faces} unique faces.")

    all_encodings_data = {"names": [], "encodings": []}
    person_id = 0
    for label_id in label_ids:
        if label_id == -1:
            continue
        
        person_id += 1
        name = f"person_{person_id}"
        
        idxs = np.where(clt.labels_ == label_id)[0]
        person_encodings = np.array(known_encodings)[idxs]
        mean_encoding = person_encodings.mean(axis=0)
        
        all_encodings_data["names"].append(name)
        all_encodings_data["encodings"].append(mean_encoding)
        logger.info(f"Created entry for ID: {name}")
        print(f"Created entry for ID: {name}")

    with open(output_encodings_path, "wb") as f:
        pickle.dump(all_encodings_data, f)
    
    logger.info(f"Encodings saved to {output_encodings_path}")
    print(f"Encodings saved to {output_encodings_path}")


def recognize_faces_in_video(video_path: str, encodings_path: str, output_csv_path: str):
    """
    Recognizes faces in a video and saves a CSV log of detections.

    Args:
        video_path (str): The path to the input video file.
        encodings_path (str): The path to the saved encodings pickle file.
        output_csv_path (str): The path to the output CSV file for logging.
    """
    try:
        # LAZY IMPORT: Only import when function is called
        import face_recognition
    except ImportError as e:
        logger.error(f"face_recognition library not available: {e}")
        raise RuntimeError("face_recognition is required for face recognition") from e
    except RuntimeError as e:
        logger.error(f"Failed to load face recognition models: {e}")
        raise RuntimeError("Face recognition models could not be loaded. Ensure face_recognition_models is installed.") from e

    try:
        with open(encodings_path, "rb") as f:
            data = pickle.load(f)
    except FileNotFoundError as e:
        logger.error(f"Encodings file not found at {encodings_path}")
        raise FileNotFoundError(f"Error: Encodings file not found at {encodings_path}") from e

    known_encodings = data["encodings"]
    known_names = data["names"]

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        logger.error(f"Could not open video file {video_path}")
        raise ValueError(f"Error: Could not open video file {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_rate = cap.get(cv2.CAP_PROP_FPS)
    
    try:
        with open(output_csv_path, "w", newline="") as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(["Timestamp (s)", "Name"])
            
            with tqdm(total=total_frames, desc="Recognizing Faces") as pbar:
                frame_count = 0
                while cap.isOpened():
                    ret, frame = cap.read()
                    if not ret:
                        break

                    rgb_small_frame = cv2.cvtColor(cv2.resize(frame, (0, 0), fx=0.25, fy=0.25), cv2.COLOR_BGR2RGB)
                    
                    face_locations = face_recognition.face_locations(rgb_small_frame)
                    face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)

                    for face_encoding in face_encodings:
                        matches = face_recognition.compare_faces(known_encodings, face_encoding)
                        name = "Unknown"

                        face_distances = face_recognition.face_distance(known_encodings, face_encoding)
                        if len(face_distances) > 0:
                            best_match_index = np.argmin(face_distances)
                            if matches[best_match_index]:
                                name = known_names[best_match_index]
                        
                        timestamp = frame_count / frame_rate
                        writer.writerow([f"{timestamp:.2f}", name])

                    frame_count += 1
                    pbar.update(1)
    finally:
        cap.release()
    
    logger.info(f"Recognition complete. Results saved to {output_csv_path}")
    print(f"Recognition complete. Results saved to {output_csv_path}")