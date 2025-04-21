import os
import sys
import firebase_admin
from firebase_admin import credentials, firestore
import logging

import os
import sys

def get_base_path():
    # When running in frozen mode (e.g. via PyInstaller), use sys._MEIPASS.
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    # Otherwise, return the parent directory of this file (which is in src). This points to the project root.
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def init_firebase():
    base_path = get_base_path()
    firebase_json_path = os.path.join(base_path, "config", "firebase-sdk.json")
    logging.info("Using firebase-sdk.json from: %s", firebase_json_path)
    logging.info("File exists: %s", os.path.exists(firebase_json_path))
    try:
        if not os.path.exists(firebase_json_path):
            raise FileNotFoundError(f"File not found: {firebase_json_path}")
        cred = credentials.Certificate(firebase_json_path)
        firebase_admin.initialize_app(cred)
        db = firestore.client()
        logging.info("Firebase initialized successfully.")
        return db
    except Exception as e:
        logging.error("Firebase initialization failed: %s", e)
        return None
