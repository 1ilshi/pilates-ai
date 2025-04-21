# Use an official Python image as the base
FROM python:3.10

# Set the working directory inside the container
WORKDIR /app

# Install system dependencies for OpenCV, PyQt, and YOLO
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libxkbcommon0 \
    libegl1 \
    libdbus-1-3 \
    libxcb-xinerama0 \
    libxcb-cursor0 \
    libx11-dev \
    qt5-qmake \
    qtbase5-dev \
    qtchooser \
    libqt5gui5 \
    libqt5core5a \
    libqt5widgets5 \
    && rm -rf /var/lib/apt/lists/*



# Copy the requirements file into the container
COPY ../requirements.txt .

# Install Python dependencies from requirements.txt
RUN pip install --no-cache-dir -r requirements.txt\
    && pip install opencv-python-headless


# Copy the Firebase credentials file into the container
COPY firebase-sdk.json /app/firebase-sdk.json

# Create the necessary 'runs' directory structure for YOLO inside the container
RUN mkdir -p /app/runs/pose/train1/weights \
    && mkdir -p /app/runs/pose/train2/weights \
    && mkdir -p /app/runs/pose/train3/weights \
    && mkdir -p /app/runs/pose/train4/weights \
    && mkdir -p /app/runs/pose/train5/weights

# Copy YOLO model weights (assuming the local 'runs' directory exists and contains 'best.pt')
COPY runs/pose/train1/weights/best.pt /app/runs/pose/train1/weights/
COPY runs/pose/train2/weights/best.pt /app/runs/pose/train2/weights/
COPY runs/pose/train3/weights/best.pt /app/runs/pose/train3/weights/
COPY runs/pose/train4/weights/best.pt /app/runs/pose/train4/weights/
COPY runs/pose/train5/weights/best.pt /app/runs/pose/train5/weights/

ENV GOOGLE_APPLICATION_CREDENTIALS="/app/firebase-sdk.json"

ENV QT_QPA_PLATFORM=offscreen

# Copy the rest of your application code
COPY .. .

# Set the command to run the application (assumes pilates_ai.py is the entry point)
CMD ["python", "pilates_ai.py"]
