import sys
import time
from datetime import datetime
import cv2
import os
import firebase_admin
import requests
import logging
from logging.handlers import RotatingFileHandler

from PyQt6.QtCore import QThread, pyqtSignal, pyqtSlot, Qt
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QListWidget, QPushButton,
    QDialog, QFormLayout, QLineEdit, QLabel, QComboBox, QMessageBox, QStackedWidget
)
from firebase_admin import credentials, firestore

# ============================================================
# Logging setup with rotation: 5 MB per file, 5 backups
# ============================================================
logger = logging.getLogger()
logger.setLevel(logging.DEBUG)
formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")

# Rotating file handler
file_handler = RotatingFileHandler("app.log", maxBytes=5 * 1024 * 1024, backupCount=5)
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)

# Optional: add console output (will show up if you're running in console mode)
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)

logger.info("Application starting...")

# ============================================================
# Determine base path for bundled data
# ============================================================
if getattr(sys, "frozen", False):
    # Running as a bundled executable
    base_path = sys._MEIPASS
    logger.info("Running in frozen mode; base_path set to sys._MEIPASS")
else:
    # Running in a normal Python environment
    base_path = os.path.abspath(".")
    logger.info("Running in normal mode; base_path set to %s", base_path)

firebase_json_path = os.path.join(base_path, "firebase-sdk.json")
logger.info("Using firebase-sdk.json from: %s", firebase_json_path)
logger.info("File exists: %s", os.path.exists(firebase_json_path))

try:
    if not os.path.exists(firebase_json_path):
        raise FileNotFoundError(f"File not found: {firebase_json_path}")

    cred = credentials.Certificate(firebase_json_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    logger.info("Firebase initialized successfully.")
except Exception as e:
    logger.error("Firebase initialization failed: %s", e)
    db = None

# ============================================================
# Define model URLs and local paths
# ============================================================
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

MODEL_PATHS = {
    "pose1": "pose/train1/best.pt",
    "pose2": "pose/train2/best.pt",
    "pose3": "pose/train3/best.pt",
    "pose4": "pose/train4/best.pt",
    "pose5": "pose/train5/best.pt"
}

# ============================================================
# Function: Download model if not present
# ============================================================
def download_model(url, save_path, splash=None):
    logger.info("Checking if model exists at: %s", save_path)
    if not os.path.exists(save_path):
        if splash:
            splash.update_status(f"Downloading model to {save_path}...")
        logger.info("Downloading model from %s", url)
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
            logger.info("Model downloaded and saved to %s", save_path)
        except Exception as e:
            if splash:
                splash.update_status(f"Error downloading model: {e}")
            logger.error("Failed to download model from %s. Error: %s", url, e)
    else:
        if splash:
            splash.update_status(f"Model already exists at {save_path}")
        logger.info("Model already exists at %s", save_path)

# ============================================================
# Download all models
# ============================================================
logger.info("Starting model downloads.")
for pose, url in MODEL_URLS.items():
    if "URL_FOR" not in url:  # Skip placeholders if any
        download_model(url, MODEL_PATHS[pose])
logger.info("Model downloads complete.")

# ============================================================
# Load YOLO models
# ============================================================
from ultralytics import YOLO

models = {}
for pose, path in MODEL_PATHS.items():
    if os.path.exists(path):
        try:
            models[pose] = YOLO(path)
            logger.info("%s model loaded successfully from %s", pose.capitalize(), path)
        except Exception as e:
            logger.error("Failed to load %s model from %s: %s", pose, path, e)
    else:
        logger.error("%s model not available at %s. Please check.", pose.capitalize(), path)

# ============================================================
# Splash Screen Class
# ============================================================
class SplashScreen(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Model Downloader")
        self.setGeometry(600, 300, 400, 150)
        self.layout = QVBoxLayout()
        self.status_label = QLabel("Initializing...")
        self.layout.addWidget(self.status_label)
        self.setLayout(self.layout)
        logger.info("SplashScreen initialized.")

    def update_status(self, message):
        self.status_label.setText(message)
        logger.debug("SplashScreen status updated: %s", message)
        QApplication.processEvents()  # Force UI to update

# ============================================================
# PoseDetectionThread Class
# ============================================================
class PoseDetectionThread(QThread):
    frameUpdated = pyqtSignal(QImage)
    errorOccurred = pyqtSignal(str)

    def __init__(self, model, patient_id, pose, parent=None):
        super().__init__(parent)
        self.model = model
        self.patient_id = patient_id
        self.pose = pose
        self.running = True
        logger.info("PoseDetectionThread created for %s (patient_id: %s)", pose, patient_id)

    def run(self):
        logger.info("PoseDetectionThread for %s started running.", self.pose)
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            err_msg = "Could not access webcam."
            self.errorOccurred.emit(err_msg)
            logger.error(err_msg)
            return

        last_time = time.time()
        while self.running and cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                logger.error("Failed to read frame from webcam. Retrying in 100ms...")
                QThread.msleep(100)  # Wait a bit and then try again instead of stopping
                continue

            # Run model on the current frame
            try:
                results = self.model(frame)
                logger.debug("Model processed frame for %s.", self.pose)
            except Exception as e:
                logger.error("Error processing frame in model for %s: %s", self.pose, e)
                results = []

            for r in results:
                if hasattr(r, "keypoints") and r.keypoints is not None and r.keypoints.conf is not None:
                    confidences = r.keypoints.conf
                    # Optionally log individual probabilities:
                    logger.debug("Raw probabilities for %s: %s", self.pose, list(confidences))
                    avg_confidence = float(confidences.mean() * 100) if len(confidences) > 0 else 0.0
                    detected_class = (
                        r.names[r.class_id] if hasattr(r, 'class_id') and r.class_id is not None else "Unknown"
                    )
                    logger.info("Pose %s - Class: %s, Accuracy: %.2f%%", self.pose, detected_class, avg_confidence)

                    current_time = time.time()
                    if current_time - last_time >= 3:
                        last_time = current_time
                        metrics_data = {
                            "accuracy": avg_confidence,
                            "timestamp": datetime.utcnow()
                        }
                        try:
                            db.collection("patients").document(self.patient_id) \
                                .collection(self.pose).add(metrics_data)
                            logger.info("Firestore updated for %s: %s", self.pose, metrics_data)
                        except Exception as e:
                            logger.error("Error writing to Firestore for %s: %s", self.pose, e)

            # Annotate frame for display (if possible)
            if len(results) > 0:
                try:
                    annotated_frame = results[0].plot()
                except Exception as e:
                    logger.error("Annotation failed for %s: %s", self.pose, e)
                    annotated_frame = frame
            else:
                annotated_frame = frame

            rgb_frame = cv2.cvtColor(annotated_frame, cv2.COLOR_BGR2RGB)
            height, width, channel = rgb_frame.shape
            bytesPerLine = 3 * width
            q_img = QImage(rgb_frame.data, width, height, bytesPerLine, QImage.Format.Format_RGB888)
            self.frameUpdated.emit(q_img)
            logger.debug("Video frame updated for %s.", self.pose)
            QThread.msleep(30)
        cap.release()
        logger.info("PoseDetectionThread for %s stopped.", self.pose)

    def stop(self):
        logger.info("stop() called on PoseDetectionThread for %s", self.pose)
        self.running = False
        logger.info("PoseDetectionThread for %s has been stopped.", self.pose)

# ============================================================
# PatientDetailsPage Class
# ============================================================
class PatientDetailsPage(QWidget):
    def __init__(self, patient_id, back_callback, parent=None):
        super().__init__(parent)
        self.patient_id = patient_id
        self.pose_thread = None
        self.current_pose = None
        self.back_callback = back_callback

        self.layout = QVBoxLayout()

        self.info_label = QLabel("Patient Info Loading...")
        self.layout.addWidget(self.info_label)

        self.video_label = QLabel("Video Feed")
        self.video_label.setFixedSize(320, 240)
        self.layout.addWidget(self.video_label)

        for pose, model in models.items():
            btn = QPushButton(f"Start Pose Detection - {pose.capitalize()}")
            btn.setStyleSheet("background-color: green; color: white;")
            btn.clicked.connect(lambda checked, p=pose: self.start_pose_detection(p))
            self.layout.addWidget(btn)

        self.stop_button = QPushButton("Stop Pose Detection")
        self.stop_button.setStyleSheet("background-color: yellow; color: gray; font-weight: bold;")
        self.stop_button.clicked.connect(self.stop_pose_detection)
        self.layout.addWidget(self.stop_button)

        self.delete_button = QPushButton("Delete Patient")
        self.delete_button.setStyleSheet("background-color: red; color: white; font-weight: bold;")
        self.delete_button.clicked.connect(self.delete_patient)
        self.layout.addWidget(self.delete_button)

        self.back_button = QPushButton("Back to List")
        self.back_button.clicked.connect(self.back_callback)
        self.layout.addWidget(self.back_button)

        self.status_label = QLabel("")
        self.layout.addWidget(self.status_label)

        self.setLayout(self.layout)
        logger.info("PatientDetailsPage initialized for patient_id: %s", self.patient_id)
        self.load_patient_details()

    def load_patient_details(self):
        try:
            doc = db.collection("patients").document(self.patient_id).get()
            if doc.exists:
                data = doc.to_dict()
                self.info_label.setText(
                    f"Name: {data.get('name')}\n"
                    f"Age: {data.get('age')}\n"
                    f"Weight: {data.get('weight')}\n"
                    f"Height: {data.get('height')}\n"
                    f"Gender: {data.get('gender')}"
                )
                logger.info("Loaded patient details for %s", self.patient_id)
            else:
                self.info_label.setText("Patient not found.")
                logger.warning("Patient not found: %s", self.patient_id)
        except Exception as e:
            self.info_label.setText("Error loading patient.")
            logger.error("Error loading patient %s: %s", self.patient_id, e)

    def start_pose_detection(self, pose):
        if self.pose_thread and self.pose_thread.isRunning():
            self.status_label.setText("Detection already running.")
            logger.info("Detection already running for %s", pose)
            return

        model = models.get(pose)
        if model:
            logger.info("Starting pose detection for %s", pose)
            self.pose_thread = PoseDetectionThread(model, self.patient_id, pose)
            self.pose_thread.frameUpdated.connect(self.update_video_frame)
            self.pose_thread.errorOccurred.connect(self.handle_error)
            self.pose_thread.start()
            self.status_label.setText(f"Started pose: {pose.capitalize()}")
        else:
            logger.error("No model available for %s", pose)

    def stop_pose_detection(self):
        logger.info("stop_pose_detection() called.")
        if self.pose_thread:
            logger.info("Stopping pose detection.")
            self.pose_thread.stop()
            self.pose_thread = None
            self.status_label.setText("Detection stopped.")
            self.video_label.clear()
        else:
            logger.info("No detection thread active to stop.")

    def delete_patient(self):
        try:
            db.collection("patients").document(self.patient_id).delete()
            logger.info("Deleted patient %s from Firestore.", self.patient_id)
            self.back_callback()
        except Exception as e:
            logger.error("Failed to delete patient %s: %s", self.patient_id, e)
            QMessageBox.critical(self, "Error", f"Failed to delete patient: {e}")

    @pyqtSlot(QImage)
    def update_video_frame(self, q_img):
        pixmap = QPixmap.fromImage(q_img).scaled(
            self.video_label.width(), self.video_label.height()
        )
        self.video_label.setPixmap(pixmap)
        logger.debug("Video frame updated in PatientDetailsPage.")

    @pyqtSlot(str)
    def handle_error(self, message):
        self.status_label.setText(message)
        logger.error("Error in detection thread: %s", message)
        QMessageBox.critical(self, "Error", message)

# ============================================================
# PatientListApp Class
# ============================================================
class PatientListApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Pilates AI")
        self.setGeometry(100, 100, 800, 600)
        self.resize(1200, 800)
        logger.info("PatientListApp initialized.")

        self.stack = QStackedWidget()
        self.layout = QVBoxLayout(self)
        self.layout.addWidget(self.stack)

        self.list_page = QWidget()
        self.stack.addWidget(self.list_page)
        self.init_list_ui()

    def init_list_ui(self):
        layout = QVBoxLayout()

        self.listWidget = QListWidget()
        self.listWidget.itemClicked.connect(self.open_patient_details)
        self.add_button = QPushButton("Add Patient")
        self.add_button.clicked.connect(self.show_add_patient_dialog)

        layout.addWidget(self.listWidget)
        layout.addWidget(self.add_button)
        self.list_page.setLayout(layout)

        self.load_patients()

    def load_patients(self):
        self.listWidget.clear()
        try:
            for patient in db.collection("patients").stream():
                name = patient.get("name")
                pid = patient.id
                self.listWidget.addItem(f"{name} | {pid}")
            logger.info("Patients loaded successfully.")
        except Exception as e:
            logger.error("Failed to load patients: %s", e)

    def open_patient_details(self, item):
        pid = item.text().split(" | ")[-1]
        logger.info("Opening details for patient %s", pid)
        details_page = PatientDetailsPage(pid, self.show_list_page)
        self.stack.addWidget(details_page)
        self.stack.setCurrentWidget(details_page)

    def show_list_page(self):
        self.load_patients()
        self.stack.setCurrentWidget(self.list_page)
        logger.info("Switched back to patient list.")

    def show_add_patient_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Add Patient")
        form = QFormLayout()

        name = QLineEdit()
        age = QLineEdit()
        weight = QLineEdit()
        height = QLineEdit()
        gender = QComboBox()
        gender.addItems(["Male", "Female"])

        form.addRow("Name:", name)
        form.addRow("Age:", age)
        form.addRow("Weight:", weight)
        form.addRow("Height:", height)
        form.addRow("Gender:", gender)

        add_btn = QPushButton("Add")
        form.addWidget(add_btn)

        def save():
            if name.text():
                try:
                    db.collection("patients").add({
                        "name": name.text(),
                        "age": age.text(),
                        "weight": weight.text(),
                        "height": height.text(),
                        "gender": gender.currentText()
                    })
                    logger.info("Added new patient: %s", name.text())
                    self.load_patients()
                    dialog.accept()
                except Exception as e:
                    logger.error("Failed to add patient: %s", e)
                    QMessageBox.critical(dialog, "Error", f"Failed to add patient: {e}")

        add_btn.clicked.connect(save)
        dialog.setLayout(form)
        dialog.exec()
        logger.info("Add patient dialog closed.")

# ============================================================
# Main Execution
# ============================================================
if __name__ == "__main__":
    logger.info("Starting QApplication.")
    app = QApplication(sys.argv)

    splash = SplashScreen()
    splash.show()

    for pose, url in MODEL_URLS.items():
        if "URL_FOR" not in url:
            download_model(url, MODEL_PATHS[pose], splash)
    logger.info("All models downloaded via splash screen.")

    splash.update_status("Loading application...")
    time.sleep(1)
    splash.close()
    logger.info("Splash screen closed.")

    window = PatientListApp()
    window.show()
    logger.info("PatientListApp shown.")

    exit_code = sys.exit(app.exec())
    logger.info("Application exiting with code %s", exit_code)
