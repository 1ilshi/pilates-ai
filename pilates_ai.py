import sys
import time
from datetime import datetime
import cv2
import os
import firebase_admin
import requests

from PyQt6.QtCore import QThread, pyqtSignal, pyqtSlot, Qt
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QListWidget, QPushButton,
    QDialog, QFormLayout, QLineEdit, QLabel, QComboBox, QMessageBox, QStackedWidget
)
from firebase_admin import credentials, firestore

# Determine base path for bundled data
if getattr(sys, "frozen", False):
    # Running as a bundled executable
    base_path = sys._MEIPASS
else:
    # Running in a normal Python environment
    base_path = os.path.abspath(".")

firebase_json_path = os.path.join(base_path, "firebase-sdk.json")
print("Using firebase-sdk.json from:", firebase_json_path)
print("File exists:", os.path.exists(firebase_json_path))

try:
    # Raise an error if file not found, so we know early
    if not os.path.exists(firebase_json_path):
        raise FileNotFoundError(f"File not found: {firebase_json_path}")

    cred = credentials.Certificate(firebase_json_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("Firebase initialized successfully.")
except Exception as e:
    print("Firebase initialization failed:", e)
    db = None

# Load YOLO models with relative paths
# Define the URLs for the models
MODEL_URLS = {
    "pose1": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train1%2Fbest.pt?alt=media"
             "&token=e42eb290-17e1-4f40-bb38-338ea8cb0ae0",  # Replace with actual URL
    "pose2": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train2%2Fbest.pt?alt=media"
             "&token=ab978973-6135-4fc8-9c37-825e602f4975",  # Placeholder for you to add
    "pose3": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train3%2Fbest.pt?alt=media"
             "&token=8e766997-f1b7-467c-9e1d-7f5d41e536f5",  # Placeholder for you to add
    "pose4": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train4%2Fbest.pt?alt=media"
             "&token=51cf08df-cfe5-45bc-921c-d449fe7f36f4",  # Placeholder for you to add
    "pose5": "https://firebasestorage.googleapis.com/v0/b/pilates-ai.firebasestorage.app/o/train5%2Fbest.pt?alt=media"
             "&token=a309929f-c24c-4f5c-a07e-7878f176d453"  # Placeholder for you to add
}

# Define the local paths where models will be stored
MODEL_PATHS = {
    "pose1": "pose/train1/best.pt",
    "pose2": "pose/train2/best.pt",
    "pose3": "pose/train3/best.pt",
    "pose4": "pose/train4/best.pt",
    "pose5": "pose/train5/best.pt"
}


# Function to download the model if it doesn't already exist locally
def download_model(url, save_path, splash=None):
    if not os.path.exists(save_path):
        if splash:
            splash.update_status(f"Downloading model to {save_path}...")
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
        except Exception as e:
            if splash:
                splash.update_status(f"Error downloading model: {e}")
            print(f"Failed to download model from {url}. Error: {e}")
    else:
        if splash:
            splash.update_status(f"Model already exists at {save_path}")



# Download all models
for pose, url in MODEL_URLS.items():
    if "URL_FOR" not in url:  # Skip models with placeholder URLs
        download_model(url, MODEL_PATHS[pose])

# Load the YOLO models
from ultralytics import YOLO

models = {}
for pose, path in MODEL_PATHS.items():
    if os.path.exists(path):  # Ensure the model file exists before loading
        models[pose] = YOLO(path)
        print(f"{pose.capitalize()} model loaded from {path}")
    else:
        print(f"{pose.capitalize()} model not available at {path}. Please check.")


class SplashScreen(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Model Downloader")
        self.setGeometry(600, 300, 400, 150)
        self.layout = QVBoxLayout()
        self.status_label = QLabel("Initializing...")
        self.layout.addWidget(self.status_label)
        self.setLayout(self.layout)

    def update_status(self, message):
        self.status_label.setText(message)
        QApplication.processEvents()  # Force UI to update


class PoseDetectionThread(QThread):
    # Signal for transmitting a QImage to update the UI
    frameUpdated = pyqtSignal(QImage)
    errorOccurred = pyqtSignal(str)

    def __init__(self, model, patient_id, pose, parent=None):
        super().__init__(parent)
        self.model = model
        self.patient_id = patient_id
        self.pose = pose
        self.running = True

    def run(self):
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            self.errorOccurred.emit("Could not access webcam.")
            return

        last_time = time.time()
        while self.running and cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            # Run the model on the current frame
            results = self.model(frame)

            for r in results:
                if hasattr(r, "keypoints") and r.keypoints is not None and r.keypoints.conf is not None:
                    confidences = r.keypoints.conf
                    avg_confidence = float(confidences.mean() * 100) if len(confidences) > 0 else 0.0
                    detected_class = (
                        r.names[r.class_id] if hasattr(r, 'class_id') and r.class_id is not None else "Unknown"
                    )
                    print(f"Class: {detected_class}, Accuracy: {avg_confidence:.2f}%")

                    # Write metrics every second
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
                        except Exception as e:
                            print("Error writing to Firestore:", e)

            # For display, try to get an annotated frame.
            if len(results) > 0:
                try:
                    annotated_frame = results[0].plot()
                except Exception as e:
                    print("Annotation failed:", e)
                    annotated_frame = frame
            else:
                annotated_frame = frame

            # Convert the BGR frame to a QImage
            rgb_frame = cv2.cvtColor(annotated_frame, cv2.COLOR_BGR2RGB)
            height, width, channel = rgb_frame.shape
            bytesPerLine = 3 * width
            q_img = QImage(rgb_frame.data, width, height, bytesPerLine, QImage.Format.Format_RGB888)
            self.frameUpdated.emit(q_img)

            # Sleep a short time to yield control and process events
            QThread.msleep(30)

        cap.release()

    def stop(self):
        self.running = False
        self.wait()


# PATIENT DETAILS PAGE
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
            btn.setStyleSheet("background-color: green; color: white;")  # Make button green
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
            else:
                self.info_label.setText("Patient not found.")
        except Exception as e:
            self.info_label.setText("Error loading patient.")
            print(e)

    def start_pose_detection(self, pose):
        if self.pose_thread and self.pose_thread.isRunning():
            self.status_label.setText("Detection already running.")
            return

        model = models.get(pose)
        if model:
            self.pose_thread = PoseDetectionThread(model, self.patient_id, pose)
            self.pose_thread.frameUpdated.connect(self.update_video_frame)
            self.pose_thread.errorOccurred.connect(self.handle_error)
            self.pose_thread.start()
            self.status_label.setText(f"Started pose: {pose.capitalize()}")

    def stop_pose_detection(self):
        if self.pose_thread:
            self.pose_thread.stop()
            self.pose_thread = None
            self.status_label.setText("Detection stopped.")
            self.video_label.clear()

    def delete_patient(self):
        try:
            db.collection("patients").document(self.patient_id).delete()
            self.back_callback()
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to delete patient: {e}")

    @pyqtSlot(QImage)
    def update_video_frame(self, q_img):
        pixmap = QPixmap.fromImage(q_img).scaled(
            self.video_label.width(), self.video_label.height()
        )
        self.video_label.setPixmap(pixmap)

    @pyqtSlot(str)
    def handle_error(self, message):
        self.status_label.setText(message)
        QMessageBox.critical(self, "Error", message)


# MAIN APPLICATION WINDOW
class PatientListApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Pilates AI")
        self.setGeometry(100, 100, 800, 600)
        self.resize(1200, 800)


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
        except Exception as e:
            print("Failed to load patients:", e)

    def open_patient_details(self, item):
        pid = item.text().split(" | ")[-1]
        details_page = PatientDetailsPage(pid, self.show_list_page)
        self.stack.addWidget(details_page)
        self.stack.setCurrentWidget(details_page)

    def show_list_page(self):
        self.load_patients()
        self.stack.setCurrentWidget(self.list_page)

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
                    self.load_patients()
                    dialog.accept()
                except Exception as e:
                    QMessageBox.critical(dialog, "Error", f"Failed to add patient: {e}")

        add_btn.clicked.connect(save)
        dialog.setLayout(form)
        dialog.exec()


# MAIN EXECUTION
if __name__ == "__main__":
    app = QApplication(sys.argv)

    splash = SplashScreen()
    splash.show()

    for pose, url in MODEL_URLS.items():
        if "URL_FOR" not in url:
            download_model(url, MODEL_PATHS[pose], splash)

    splash.update_status("Loading application...")
    time.sleep(1)
    splash.close()

    window = PatientListApp()
    window.show()

    sys.exit(app.exec())