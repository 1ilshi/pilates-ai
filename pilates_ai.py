import sys
import time
from datetime import datetime
import cv2
import os
import firebase_admin
import requests

from PyQt6.QtCore import QThread, pyqtSignal, pyqtSlot
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QListWidget, QPushButton,
    QDialog, QFormLayout, QLineEdit, QLabel, QComboBox, QMessageBox
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
def download_model(url, save_path):
    if not os.path.exists(save_path):
        print(f"Downloading model from {url}...")
        try:
            response = requests.get(url)
            response.raise_for_status()
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            with open(save_path, "wb") as f:
                f.write(response.content)
            print(f"Model saved to {save_path}")
        except Exception as e:
            print(f"Failed to download model from {url}. Error: {e}")
    else:
        print(f"Model already exists at {save_path}")


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
                    if current_time - last_time >= 1:
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


class PatientDetailsPage(QWidget):
    def __init__(self, patient_id, parent=None):
        super().__init__(parent)
        self.patient_id = patient_id
        self.pose_thread = None
        self.current_pose = None

        self.setWindowTitle("Patient Details")
        self.setGeometry(300, 300, 400, 300)
        self.layout = QVBoxLayout()

        self.info_label = QLabel("Patient Info Loading...")
        self.layout.addWidget(self.info_label)

        # Video feed display label
        self.video_label = QLabel("Video Feed")
        self.video_label.setFixedSize(320, 240)
        self.layout.addWidget(self.video_label)

        # Buttons for each pose model
        for pose, model in models.items():
            btn = QPushButton(f"Start Pose Detection - {pose.capitalize()}")
            btn.clicked.connect(lambda checked, p=pose: self.start_pose_detection(p))
            self.layout.addWidget(btn)

        self.stop_button = QPushButton("Stop Pose Detection")
        self.stop_button.clicked.connect(self.stop_pose_detection)
        self.layout.addWidget(self.stop_button)

        # Delete patient button
        self.delete_button = QPushButton("Delete Patient")
        self.delete_button.clicked.connect(self.delete_patient)
        self.layout.addWidget(self.delete_button)

        self.status_label = QLabel("")
        self.layout.addWidget(self.status_label)

        self.load_patient_details()
        self.setLayout(self.layout)

    def load_patient_details(self):
        try:
            doc = db.collection("patients").document(self.patient_id).get()
            if doc.exists:
                patient_data = doc.to_dict()
                details = (
                    f"Name: {patient_data.get('name')}\n"
                    f"Age: {patient_data.get('age')}\n"
                    f"Weight: {patient_data.get('weight')}\n"
                    f"Height: {patient_data.get('height')}\n"
                    f"Tel: {patient_data.get('tel_number')}\n"
                    f"Address: {patient_data.get('address')}\n"
                    f"Gender: {patient_data.get('gender')}"
                )
                self.info_label.setText(details)
            else:
                self.info_label.setText("Patient record not found.")
        except Exception as e:
            self.info_label.setText("Error loading patient details.")
            print("Error loading patient details:", e)

    def start_pose_detection(self, pose):
        if self.pose_thread is not None and self.pose_thread.isRunning():
            self.status_label.setText("A pose detection is already running.")
            return

        self.current_pose = pose
        model = models.get(pose)
        if model:
            self.pose_thread = PoseDetectionThread(model, self.patient_id, pose)
            self.pose_thread.frameUpdated.connect(self.update_video_frame)
            self.pose_thread.errorOccurred.connect(self.handle_error)
            self.pose_thread.start()
            self.status_label.setText(f"Pose detection started for {pose.capitalize()}.")
        else:
            self.status_label.setText("Invalid pose selection.")

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

    def stop_pose_detection(self):
        if self.pose_thread is not None:
            self.pose_thread.stop()
            self.pose_thread = None
            self.status_label.setText("Pose detection stopped.")
            self.video_label.clear()

    def delete_patient(self):
        try:
            db.collection("patients").document(self.patient_id).delete()
            self.close()
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to delete patient: {e}")
            print("Error deleting patient:", e)


class PatientListApp(QWidget):
    def __init__(self):
        super().__init__()
        self.initUI()
        self.load_patients()

    def initUI(self):
        self.setWindowTitle("Pilates AI")
        self.setGeometry(100, 100, 400, 400)

        self.layout = QVBoxLayout()
        self.listWidget = QListWidget()
        self.listWidget.itemClicked.connect(self.open_patient_details)

        self.add_button = QPushButton("Add Patient")
        self.add_button.clicked.connect(self.show_add_patient_dialog)

        self.layout.addWidget(self.listWidget)
        self.layout.addWidget(self.add_button)
        self.setLayout(self.layout)

    def load_patients(self):
        self.listWidget.clear()
        try:
            patients_ref = db.collection("patients").stream()
            for patient in patients_ref:
                item_text = patient.get("name")
                item_id = patient.id
                self.listWidget.addItem(f"{item_text} | {item_id}")
        except Exception as e:
            print("Error loading patients:", e)

    def open_patient_details(self, item):
        patient_id = item.text().split(" | ")[-1]
        self.details_page = PatientDetailsPage(patient_id)
        self.details_page.show()

    def show_add_patient_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Add Patient")
        layout = QFormLayout()

        name_input = QLineEdit()
        age_input = QLineEdit()
        weight_input = QLineEdit()
        height_input = QLineEdit()
        tel_input = QLineEdit()
        address_input = QLineEdit()

        gender_input = QComboBox()
        gender_input.addItems(["Male", "Female"])

        layout.addRow("Name:", name_input)
        layout.addRow("Age:", age_input)
        layout.addRow("Weight:", weight_input)
        layout.addRow("Height:", height_input)
        layout.addRow("Tel Number:", tel_input)
        layout.addRow("Address:", address_input)
        layout.addRow("Gender:", gender_input)

        add_button = QPushButton("Add")

        def save_patient():
            if name_input.text():
                try:
                    db.collection("patients").add({
                        "name": name_input.text(),
                        "age": age_input.text(),
                        "weight": weight_input.text(),
                        "height": height_input.text(),
                        "tel_number": tel_input.text(),
                        "address": address_input.text(),
                        "gender": gender_input.currentText()
                    })
                    self.load_patients()
                    dialog.accept()
                except Exception as e:
                    QMessageBox.critical(dialog, "Error", f"Failed to add patient: {e}")
                    print("Error adding patient:", e)

        add_button.clicked.connect(save_patient)
        layout.addWidget(add_button)

        dialog.setLayout(layout)
        dialog.exec()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = PatientListApp()
    window.show()
    sys.exit(app.exec())
