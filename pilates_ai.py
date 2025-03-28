import sys
import time
from datetime import datetime
import cv2
import firebase_admin
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QListWidget, QPushButton,
    QDialog, QFormLayout, QLineEdit, QLabel, QComboBox
)
from firebase_admin import credentials, firestore
from ultralytics import YOLO
import os

# Global variable to store current patient
current_patient_id = None

# Get the current directory of the script
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Initialize Firebase with a relative path
cred = credentials.Certificate("firebase-sdk.json")
firebase_admin.initialize_app(cred)
db = firestore.client()

# Load YOLO models with relative paths
models = {
    "pose1": YOLO(os.path.join("runs/pose/train1/weights/best.pt")),
    "pose2": YOLO(os.path.join("runs/pose/train2/weights/best.pt")),
    "pose3": YOLO(os.path.join("runs/pose/train3/weights/best.pt")),
    "pose4": YOLO(os.path.join("runs/pose/train4/weights/best.pt")),
    "pose5": YOLO(os.path.join("runs/pose/train5/weights/best.pt"))
}


class PatientDetailsPage(QWidget):
    def __init__(self, patient_id, parent=None):
        super().__init__(parent)
        self.patient_id = patient_id
        self.running = False
        self.cap = None

        self.setWindowTitle("Patient Details")
        self.setGeometry(200, 200, 500, 400)
        self.layout = QVBoxLayout()

        self.info_label = QLabel("Patient Info Loading...")
        self.layout.addWidget(self.info_label)

        # Buttons for each pose model
        for pose, model in models.items():
            btn = QPushButton(f"Start Pose Detection - {pose.capitalize()}")
            btn.clicked.connect(lambda checked, p=pose: self.start_pose_detection(p))
            self.layout.addWidget(btn)

        self.stop_button = QPushButton("Stop Running")
        self.stop_button.clicked.connect(self.stop_pose_detection)
        self.layout.addWidget(self.stop_button)

        # Delete button
        self.delete_button = QPushButton("Delete Patient")
        self.delete_button.clicked.connect(self.delete_patient)
        self.layout.addWidget(self.delete_button)

        self.load_patient_details()
        self.setLayout(self.layout)

    def load_patient_details(self):
        doc = db.collection("patients").document(self.patient_id).get()
        if doc.exists:
            patient_data = doc.to_dict()
            details = f"""
            Name: {patient_data.get('name')}
            Age: {patient_data.get('age')}
            Weight: {patient_data.get('weight')}
            Height: {patient_data.get('height')}
            Tel: {patient_data.get('tel_number')}
            Address: {patient_data.get('address')}
            Gender: {patient_data.get('gender')}
            """
            self.info_label.setText(details)

    def start_pose_detection(self, pose):
        if self.running:
            return
        self.running = True
        self.cap = cv2.VideoCapture(0)
        if not self.cap.isOpened():
            print("Error: Could not access webcam")
            self.running = False
            return
        self.process_camera(models[pose], pose)

    def process_camera(self, model, pose):
        last_time = time.time()
        while self.running and self.cap.isOpened():
            ret, frame = self.cap.read()
            if not ret:
                break

            results = model(frame)
            for r in results:
                if r.keypoints and r.keypoints.conf is not None:
                    confidences = r.keypoints.conf
                    avg_confidence = float(confidences.mean() * 100) if len(confidences) > 0 else 0.0
                    detected_class = (
                        r.names[r.class_id] if hasattr(r, 'class_id') and r.class_id is not None else "Unknown"
                    )

                    print(f"Class: {detected_class}, Accuracy: {avg_confidence:.2f}%")

                    current_time = time.time()
                    if current_time - last_time >= 1:
                        last_time = current_time
                        metrics_data = {
                            "accuracy": avg_confidence,
                            "timestamp": datetime.utcnow()
                        }
                        db.collection("patients").document(self.patient_id).collection(pose).add(metrics_data)

                im_array = results[0].plot()
                cv2.imshow("Pose Detection", im_array)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
        self.stop_pose_detection()

    def stop_pose_detection(self):
        self.running = False
        if self.cap:
            self.cap.release()
        cv2.destroyAllWindows()

    def delete_patient(self):
        db.collection("patients").document(self.patient_id).delete()
        self.close()


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
        patients_ref = db.collection("patients").stream()
        for patient in patients_ref:
            item_text = patient.get("name")
            item_id = patient.id
            self.listWidget.addItem(f"{item_text} | {item_id}")

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

        add_button.clicked.connect(save_patient)
        layout.addWidget(add_button)

        dialog.setLayout(layout)
        dialog.exec()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = PatientListApp()
    window.show()
    sys.exit(app.exec())
