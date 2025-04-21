import os
import requests
import logging
from ultralytics import YOLO  # Ensure you have ultralytics installed

# Define model download URLs.
MODEL_URLS = {
    "pose1": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train1%2Fbest.pt?alt=media"
             "&token=e42eb290-17e1-4f40-bb38-338ea8cb0ae0",
    "pose2": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train2%2Fbest.pt?alt=media"
             "&token=ab978973-6135-4fc8-9c37-825e602f4975",
    "pose3": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train3%2Fbest.pt?alt=media"
             "&token=8e766997-f1b7-467c-9e1d-7f5d41e536f5",
    "pose4": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train4%2Fbest.pt?alt=media"
             "&token=51cf08df-cfe5-45bc-921c-d449fe7f36f4",
    "pose5": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train5%2Fbest.pt?alt=media"
             "&token=a309929f-c24c-4f5c-a07e-7878f176d453"
}

# Define where to store each model locally.
MODEL_PATHS = {
    "pose1": os.path.join("models", "pose1", "best.pt"),
    "pose2": os.path.join("models", "pose2", "best.pt"),
    "pose3": os.path.join("models", "pose3", "best.pt"),
    "pose4": os.path.join("models", "pose4", "best.pt"),
    "pose5": os.path.join("models", "pose5", "best.pt")
}

def download_model(url, save_path, splash=None):
    logging.info("Checking if model exists at: %s", save_path)
    if not os.path.exists(save_path):
        if splash:
            splash.update_status(f"Downloading model to {save_path}...")
        logging.info("Downloading model from %s", url)
        try:
            response = requests.get(url, stream=True)
            response.raise_for_status()
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            total_size = int(response.headers.get("content-length", 0))
            downloaded = 0
            with open(save_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if splash and total_size:
                            percent = int((downloaded / total_size) * 100)
                            splash.update_status(f"Downloading {os.path.basename(save_path)}... {percent}%")
            if splash:
                splash.update_status(f"Model saved to {save_path}")
            logging.info("Model downloaded and saved to %s", save_path)
        except Exception as e:
            if splash:
                splash.update_status(f"Error downloading model: {e}")
            logging.error("Failed to download model from %s. Error: %s", url, e)
    else:
        if splash:
            splash.update_status(f"Model already exists at {save_path}")
        logging.info("Model already exists at %s", save_path)

def load_yolo_models():
    models = {}
    for pose, path in MODEL_PATHS.items():
        if os.path.exists(path):
            try:
                models[pose] = YOLO(path)
                logging.info("%s model loaded successfully from %s", pose.capitalize(), path)
            except Exception as e:
                logging.error("Failed to load %s model from %s: %s", pose, path, e)
        else:
            logging.error("%s model not available at %s. Please check.", pose.capitalize(), path)
    return models
