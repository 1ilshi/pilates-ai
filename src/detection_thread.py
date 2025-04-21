import time
import cv2
import logging
from datetime import datetime
from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtGui import QImage

class PoseDetectionThread(QThread):
    frameUpdated = pyqtSignal(QImage)
    errorOccurred = pyqtSignal(str)

    def __init__(self, model, patient_id, pose, db, parent=None):
        super().__init__(parent)
        self.model = model
        self.patient_id = patient_id
        self.pose = pose
        self.db = db
        self.running = True
        logging.info("PoseDetectionThread created for %s (patient_id: %s)", pose, patient_id)

    def run(self):
        logging.info("PoseDetectionThread for %s started running.", self.pose)
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            err_msg = "Could not access webcam."
            self.errorOccurred.emit(err_msg)
            logging.error(err_msg)
            return
        last_time = time.time()
        while self.running and cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                logging.error("Failed to read frame from webcam. Retrying in 100ms...")
                QThread.msleep(100)
                continue
            try:
                results = self.model(frame)
                logging.debug("Model processed frame for %s.", self.pose)
            except Exception as e:
                logging.error("Error processing frame in model for %s: %s", self.pose, e)
                results = []
            for r in results:
                if hasattr(r, "keypoints") and r.keypoints is not None and r.keypoints.conf is not None:
                    confidences = r.keypoints.conf
                    logging.debug("Raw probabilities for %s: %s", self.pose, list(confidences))
                    avg_confidence = float(confidences.mean() * 100) if len(confidences) > 0 else 0.0
                    detected_class = (r.names[r.class_id] if hasattr(r, 'class_id') and r.class_id is not None else "Unknown")
                    logging.info("Pose %s - Class: %s, Accuracy: %.2f%%", self.pose, detected_class, avg_confidence)
                    current_time = time.time()
                    if current_time - last_time >= 3:
                        last_time = current_time
                        metrics_data = {"accuracy": avg_confidence, "timestamp": datetime.utcnow()}
                        try:
                            self.db.collection("patients").document(self.patient_id) \
                                .collection(self.pose).add(metrics_data)
                            logging.info("Firestore updated for %s: %s", self.pose, metrics_data)
                        except Exception as e:
                            logging.error("Error writing to Firestore for %s: %s", self.pose, e)
            if len(results) > 0:
                try:
                    annotated_frame = results[0].plot()
                except Exception as e:
                    logging.error("Annotation failed for %s: %s", self.pose, e)
                    annotated_frame = frame
            else:
                annotated_frame = frame
            rgb_frame = cv2.cvtColor(annotated_frame, cv2.COLOR_BGR2RGB)
            height, width, channel = rgb_frame.shape
            bytesPerLine = 3 * width
            q_img = QImage(rgb_frame.data, width, height, bytesPerLine, QImage.Format.Format_RGB888)
            self.frameUpdated.emit(q_img)
            logging.debug("Video frame updated for %s.", self.pose)
            QThread.msleep(30)
        cap.release()
        logging.info("PoseDetectionThread for %s stopped.", self.pose)

    def stop(self):
        logging.info("stop() called on PoseDetectionThread for %s", self.pose)
        self.running = False
        logging.info("PoseDetectionThread for %s has been stopped.", self.pose)
