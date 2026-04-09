
import { useState, useEffect, useRef } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export type EngagementState = 'attentive' | 'interested' | 'bored' | 'distracted' | 'sleepy' | 'fatigued' | 'absent';

export interface StudentData {
  id: number;
  state: EngagementState;
  attentionScore: number;
  lastSeen: number;
  bbox: { x: number, y: number, w: number, h: number };
  eyeState: 'open' | 'half-closed' | 'closed' | 'widened';
  confidence: number;
  timestamp: string;
}

export function useAttentionMonitor() {
  const [students, setStudents] = useState<StudentData[]>([]);
  const [avgAttention, setAvgAttention] = useState(0);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isModelReady, setIsModelReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const requestRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    let active = true;
    const initLandmarker = async () => {
      try {
        const filesetResolver = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
          },
          outputFaceBlendshapes: true,
          runningMode: "VIDEO",
          numFaces: 10
        });
        if (active) {
          landmarkerRef.current = landmarker;
          setIsModelReady(true);
          console.log("FaceLandmarker initialized");
        }
      } catch (err) {
        console.error("Failed to initialize FaceLandmarker:", err);
      }
    };

    initLandmarker();
    return () => {
      active = false;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  const processFrame = () => {
    if (!videoRef.current || !landmarkerRef.current || !isCameraOn) {
      isProcessingRef.current = false;
      return;
    }

    if (videoRef.current.paused || videoRef.current.ended || videoRef.current.readyState < 2) {
      requestRef.current = requestAnimationFrame(processFrame);
      return;
    }

    try {
      const startTimeMs = performance.now();
      const results = landmarkerRef.current.detectForVideo(videoRef.current, startTimeMs);

      const now = new Date();
      const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const newStudents: StudentData[] = results.faceLandmarks.map((landmarks, index) => {
          const blendshapes = results.faceBlendshapes?.[index]?.categories || [];

          const getShape = (name: string) => blendshapes.find(c => c.categoryName === name)?.score || 0;

          const blinkLeft = getShape('eyeBlinkLeft');
          const blinkRight = getShape('eyeBlinkRight');
          const wideLeft = getShape('eyeWideLeft');
          const wideRight = getShape('eyeWideRight');
          const squintLeft = getShape('eyeSquintLeft');
          const squintRight = getShape('eyeSquintRight');

          const avgBlink = (blinkLeft + blinkRight) / 2;
          const avgWide = (wideLeft + wideRight) / 2;

          // Nose tip: 1, Left eye: 33, Right eye: 263
          const nose = landmarks[1];
          const leftEye = landmarks[33];
          const rightEye = landmarks[263];

          const eyeCenter = (leftEye.x + rightEye.x) / 2;
          const yaw = (nose.x - eyeCenter) * 150;

          const eyeYCenter = (leftEye.y + rightEye.y) / 2;
          const pitch = (nose.y - eyeYCenter) * 150;

          const xs = landmarks.map(l => l.x);
          const ys = landmarks.map(l => l.y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);

          let state: EngagementState = 'attentive';
          let eyeState: 'open' | 'half-closed' | 'closed' | 'widened' = 'open';
          let score = 100 - (Math.abs(yaw) * 1.2) - (Math.abs(pitch) * 1.2);
          let confidence = 0.95 - (avgBlink * 0.1);

          // Eye State Diagnostics
          if (avgWide > 0.4) {
            eyeState = 'widened';
            state = 'interested';
            score = Math.min(100, score + 15);
          } else if (avgBlink > 0.8) {
            eyeState = 'closed';
            state = 'sleepy';
            score -= 60;
          } else if (avgBlink > 0.4) {
            eyeState = 'half-closed';
            state = 'fatigued';
            score -= 30;
          }

          // Posture & Gaze Diagnostics
          if (Math.abs(yaw) > 25) {
            state = 'distracted';
            score -= 40;
          } else if (pitch > 18) {
            state = 'bored'; // Slouching/Looking down
            score -= 35;
          } else if (pitch < -15) {
            state = 'interested'; // Looking up/attentive
            score = Math.min(100, score + 10);
          }

          // Confidence adjustment based on visibility
          if (Math.abs(yaw) > 45) confidence -= 0.2; // Side profile reduces confidence

          return {
            id: index + 1,
            state,
            attentionScore: Math.max(0, Math.min(100, Math.round(score))),
            lastSeen: Date.now(),
            bbox: {
              x: minX,
              y: minY,
              w: maxX - minX,
              h: maxY - minY
            },
            eyeState,
            confidence: Math.round(confidence * 100) / 100,
            timestamp
          };
        });

        setStudents(newStudents);
        const total = newStudents.reduce((acc, s) => acc + s.attentionScore, 0);
        setAvgAttention(Math.round(total / newStudents.length));
      } else {
        setStudents([]);
        setAvgAttention(0);
      }
    } catch (err) {
      console.error("Error processing frame:", err);
    }

    requestRef.current = requestAnimationFrame(processFrame);
  };

  const toggleCamera = async () => {
    if (isCameraOn) {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach(track => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      setIsCameraOn(false);
      setStudents([]);
      setAvgAttention(0);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user"
          }
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play().then(() => {
              setIsCameraOn(true);
            });
          };
        }
      } catch (err) {
        console.error("Error accessing camera:", err);
        alert("Kameraga ruxsat berilmadi yoki kamera topilmadi.");
      }
    }
  };

  useEffect(() => {
    if (isCameraOn && landmarkerRef.current) {
      requestRef.current = requestAnimationFrame(processFrame);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isCameraOn]);

  return {
    students,
    avgAttention,
    isCameraOn,
    isModelReady,
    toggleCamera,
    videoRef
  };
}
