import logging
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QListWidget, QPushButton,
    QDialog, QFormLayout, QLineEdit, QComboBox, QMessageBox, QStackedWidget, QApplication
)
from PyQt6.QtGui import QPixmap, QImage
from PyQt6.QtCore import pyqtSlot
from detection_thread import PoseDetectionThread

class SplashScreen(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Model Downloader")
        self.setGeometry(600, 300, 400, 150)
        self.layout = QVBoxLayout()
        self.status_label = QLabel("Initializing...")
        self.layout.addWidget(self.status_label)
        self.setLayout(self.layout)
        logging.info("SplashScreen initialized.")

    def update_status(self, message):
        self.status_label.setText(message)
        logging.debug("SplashScreen status updated: %s", message)
        QApplication.processEvents()  # Force UI update

class PatientDetailsPage(QWidget):
    def __init__(self, patient_id, back_callback, models, db, parent=None):
        super().__init__(parent)
        self.patient_id = patient_id
        self.models = models
        self.db = db
        self.pose_thread = None
        self.back_callback = back_callback

        self.layout = QVBoxLayout()
        self.info_label = QLabel("Patient Info Loading...")
        self.layout.addWidget(self.info_label)

        self.video_label = QLabel("Video Feed")
        self.video_label.setFixedSize(320, 240)
        self.layout.addWidget(self.video_label)

        for pose in self.models.keys():
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
        logging.info("PatientDetailsPage initialized for patient_id: %s", self.patient_id)
        self.load_patient_details()

    def load_patient_details(self):
        try:
            doc = self.db.collection("patients").document(self.patient_id).get()
            if doc.exists:
                data = doc.to_dict()
                self.info_label.setText(
                    f"Name: {data.get('name')}\n"
                    f"Age: {data.get('age')}\n"
                    f"Weight: {data.get('weight')}\n"
                    f"Height: {data.get('height')}\n"
                    f"Gender: {data.get('gender')}"
                )
                logging.info("Loaded patient details for %s", self.patient_id)
            else:
                self.info_label.setText("Patient not found.")
                logging.warning("Patient not found: %s", self.patient_id)
        except Exception as e:
            self.info_label.setText("Error loading patient.")
            logging.error("Error loading patient %s: %s", self.patient_id, e)

    def start_pose_detection(self, pose):
        if self.pose_thread and self.pose_thread.isRunning():
            self.status_label.setText("Detection already running.")
            logging.info("Detection already running for %s", pose)
            return
        model = self.models.get(pose)
        if model:
            logging.info("Starting pose detection for %s", pose)
            self.pose_thread = PoseDetectionThread(model, self.patient_id, pose, self.db)
            self.pose_thread.frameUpdated.connect(self.update_video_frame)
            self.pose_thread.errorOccurred.connect(self.handle_error)
            self.pose_thread.start()
            self.status_label.setText(f"Started pose: {pose.capitalize()}")
        else:
            logging.error("No model available for %s", pose)

    def stop_pose_detection(self):
        logging.info("stop_pose_detection() called.")
        if self.pose_thread:
            logging.info("Stopping pose detection.")
            self.pose_thread.stop()
            self.pose_thread = None
            self.status_label.setText("Detection stopped.")
            self.video_label.clear()
        else:
            logging.info("No detection thread active to stop.")

    def delete_patient(self):
        try:
            self.db.collection("patients").document(self.patient_id).delete()
            logging.info("Deleted patient %s from Firestore.", self.patient_id)
            self.back_callback()
        except Exception as e:
            logging.error("Failed to delete patient %s: %s", self.patient_id, e)
            QMessageBox.critical(self, "Error", f"Failed to delete patient: {e}")

    @pyqtSlot(QImage)
    def update_video_frame(self, q_img):
        pixmap = QPixmap.fromImage(q_img).scaled(self.video_label.width(), self.video_label.height())
        self.video_label.setPixmap(pixmap)
        logging.debug("Video frame updated in PatientDetailsPage.")

    @pyqtSlot(str)
    def handle_error(self, message):
        self.status_label.setText(message)
        logging.error("Error in detection thread: %s", message)
        QMessageBox.critical(self, "Error", message)

class PatientListApp(QWidget):
    def __init__(self, models, db, parent=None):
        super().__init__(parent)
        self.models = models
        self.db = db
        self.setWindowTitle("Pilates AI")
        self.setGeometry(100, 100, 800, 600)
        self.resize(1200, 800)
        logging.info("PatientListApp initialized.")
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
            for patient in self.db.collection("patients").stream():
                name = patient.get("name")
                pid = patient.id
                self.listWidget.addItem(f"{name} | {pid}")
            logging.info("Patients loaded successfully.")
        except Exception as e:
            logging.error("Failed to load patients: %s", e)

    def open_patient_details(self, item):
        pid = item.text().split(" | ")[-1]
        logging.info("Opening details for patient %s", pid)
        details_page = PatientDetailsPage(pid, self.show_list_page, self.models, self.db)
        self.stack.addWidget(details_page)
        self.stack.setCurrentWidget(details_page)

    def show_list_page(self):
        self.load_patients()
        self.stack.setCurrentWidget(self.list_page)
        logging.info("Switched back to patient list.")

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
                    self.db.collection("patients").add({
                        "name": name.text(),
                        "age": age.text(),
                        "weight": weight.text(),
                        "height": height.text(),
                        "gender": gender.currentText()
                    })
                    logging.info("Added new patient: %s", name.text())
                    self.load_patients()
                    dialog.accept()
                except Exception as e:
                    logging.error("Failed to add patient: %s", e)
                    QMessageBox.critical(dialog, "Error", f"Failed to add patient: {e}")

        add_btn.clicked.connect(save)
        dialog.setLayout(form)
        dialog.exec()
        logging.info("Add patient dialog closed.")
