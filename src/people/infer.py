"""One persistent CPU inference process. Input lines contain base64 JPEGs."""
import base64
import json
import sys

import cv2
import numpy as np

cv2.setNumThreads(1)
detector = cv2.FaceDetectorYN.create(sys.argv[1], "", (320, 320), 0.85, 0.3, 5000)
recognizer = cv2.FaceRecognizerSF.create(sys.argv[2], "")
print("ready", flush=True)

for line in sys.stdin:
    try:
        image = cv2.imdecode(np.frombuffer(base64.b64decode(line), np.uint8), cv2.IMREAD_COLOR)
        height, width = image.shape[:2]
        detector.setInputSize((width, height))
        _, detections = detector.detect(image)
        faces = []
        if detections is not None:
            for face in detections:
                x, y, w, h = map(float, face[:4])
                if min(w, h) < 34:
                    continue
                embedding = recognizer.feature(recognizer.alignCrop(image, face)).reshape(-1)
                norm = np.linalg.norm(embedding)
                if not np.isfinite(norm) or norm == 0:
                    continue
                left, top = max(0, x), max(0, y)
                right, bottom = min(width, x + w), min(height, y + h)
                if right <= left or bottom <= top:
                    continue
                faces.append({
                    "x": left / width, "y": top / height,
                    "w": (right - left) / width, "h": (bottom - top) / height,
                    "quality": float(face[-1]) * (w * h / (width * height)) ** 0.5,
                    "embedding": (embedding / norm).tolist(),
                })
        print(json.dumps(faces, separators=(",", ":")), flush=True)
    except (cv2.error, ValueError, AttributeError):
        print("null", flush=True)
