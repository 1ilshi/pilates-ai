import sys
import time
import logging
from PyQt6.QtWidgets import QApplication
from logging_config import setup_logging
from database import init_firebase
from model_handler import MODEL_URLS, MODEL_PATHS, download_model, load_yolo_models
from ui_components import SplashScreen, PatientListApp

def main():
    # Initialize logging.
    setup_logging()
    logging.info("Starting application main()")

    # Initialize Firebase/Firestore.
    db = init_firebase()
    if db is None:
        logging.error("Exiting application due to database initialization failure.")
        sys.exit(1)

    # Create application.
    app = QApplication(sys.argv)

    # Show splash screen and download models.
    splash = SplashScreen()
    splash.show()
    for pose, url in MODEL_URLS.items():
        if "URL_FOR" not in url:
            download_model(url, MODEL_PATHS[pose], splash)
    logging.info("All models downloaded via splash screen.")
    splash.update_status("Loading application...")
    time.sleep(1)
    splash.close()

    # Load YOLO models.
    models = load_yolo_models()

    # Create and show the main window.
    window = PatientListApp(models, db)
    window.show()

    exit_code = app.exec()
    logging.info("Application exiting with code %s", exit_code)
    sys.exit(exit_code)

if __name__ == "__main__":
    main()
