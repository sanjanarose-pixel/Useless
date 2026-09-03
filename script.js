"use strict";

const camera = document.getElementById("camera");
const startButton = document.getElementById("startCamera");
const stopButton = document.getElementById("stopCamera");
const cameraStatus = document.getElementById("cameraStatus");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");
const recognitionStatus = document.getElementById("recognitionStatus");

const animalAudio = {
  deer: document.getElementById("deerAudio"),
  bird: document.getElementById("birdAudio"),
  chicken: document.getElementById("chickenAudio"),
  crab: document.getElementById("crabAudio"),
  snake: document.getElementById("snakeAudio"),
  dog: document.getElementById("dogAudio"),
};

let activeStream = null;
let imageModel = null;
let modelState = "loading";
let recognitionFrameId = null;
let lastPredictionTime = 0;
let recognitionSession = 0;

let smoothedScores = new Map();
let candidateLabel = null;
let candidateFrames = 0;

let activeAnimal = null;
let audioSession = 0;
let audioIsPrimed = false;

const MODEL_BASE_URL =
  "https://teachablemachine.withgoogle.com/models/2mx-T-4rY/";

const SUPPORTED_ANIMALS = new Set([
  "deer",
  "bird",
  "chicken",
  "crab",
  "snake",
  "dog",
]);

const MINIMUM_CONFIDENCE = 0.8;
const SMOOTHING_FACTOR = 0.35;
const REQUIRED_STABLE_PREDICTIONS = 4;
const PREDICTION_INTERVAL_MS = 160;
const ANIMAL_SOUND_THRESHOLD = 0.80;

function setCameraStatus(message, state = "off") {
  cameraStatus.classList.remove("is-active", "is-error");

  if (state === "active") cameraStatus.classList.add("is-active");
  if (state === "error") cameraStatus.classList.add("is-error");

  cameraStatus.innerHTML =
    '<span class="camera-status__dot" aria-hidden="true"></span>' + message;
}

function updateControls(isRunning) {
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
}

function setRecognitionStatus(message, state = "loading") {
  recognitionStatus.classList.remove(
    "is-ready",
    "is-detected",
    "is-error"
  );

  if (state === "ready") {
    recognitionStatus.classList.add("is-ready");
  }

  if (state === "detected") {
    recognitionStatus.classList.add("is-detected");
  }

  if (state === "error") {
    recognitionStatus.classList.add("is-error");
  }

  const dot = document.createElement("span");
  dot.className = "recognition-status__dot";
  dot.setAttribute("aria-hidden", "true");

  recognitionStatus.replaceChildren(
    dot,
    document.createTextNode(message)
  );
}

function resetRecognitionSmoothing() {
  smoothedScores = new Map();
  candidateLabel = null;
  candidateFrames = 0;
}

function stopAnimalSound() {
  audioSession += 1;
  activeAnimal = null;

  Object.values(animalAudio).forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
}

async function startAnimalSound(animal) {
  const audio = animalAudio[animal];

  if (!audio) return;

  if (activeAnimal === animal && !audio.paused) {
    return;
  }

  stopAnimalSound();

  activeAnimal = animal;
  const session = ++audioSession;

  audio.loop = true;
  audio.currentTime = 0;

  try {
    await audio.play();

    if (activeAnimal !== animal || session !== audioSession) {
      audio.pause();
      audio.currentTime = 0;
    }
  } catch (error) {
    if (activeAnimal === animal && session === audioSession) {
      activeAnimal = null;
    }
  }
}

function updateAnimalSound(animal, probability) {
  const isAboveThreshold =
    animal && probability > ANIMAL_SOUND_THRESHOLD;

  if (!isAboveThreshold) {
    if (activeAnimal !== null) {
      stopAnimalSound();
    }
    return;
  }

  if (activeAnimal !== animal) {
    startAnimalSound(animal);
  }
}

function primeAnimalAudio() {
  if (audioIsPrimed) return;

  const audioElements = Object.values(animalAudio);

  audioElements.forEach((audio) => {
    audio.muted = true;
  });

  Promise.all(
    audioElements.map((audio) =>
      audio
        .play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
        })
        .catch(() => {})
    )
  ).finally(() => {
    audioElements.forEach((audio) => {
      audio.muted = false;
    });

    audioIsPrimed = true;
  });
}

async function loadAnimalModel() {
  try {
    if (!window.tmImage) {
      throw new Error("Teachable Machine image library did not load");
    }

    imageModel = await window.tmImage.load(
      `${MODEL_BASE_URL}model.json`,
      `${MODEL_BASE_URL}metadata.json`
    );

    modelState = "ready";

    if (activeStream) {
      startRecognition();
    } else {
      setRecognitionStatus(
        "Animal model ready — start the camera",
        "ready"
      );
    }
  } catch (error) {
    imageModel = null;
    modelState = "error";

    setRecognitionStatus(
      "Animal model could not load",
      "error"
    );
  }
}

function getSmoothedTopPrediction(predictions) {
  const animalPredictions = predictions.filter((prediction) =>
    SUPPORTED_ANIMALS.has(
      prediction.className.trim().toLowerCase()
    )
  );

  animalPredictions.forEach((prediction) => {
    const label = prediction.className.trim();
    const previousScore = smoothedScores.get(label);

    const nextScore =
      previousScore === undefined
        ? prediction.probability
        : previousScore +
          SMOOTHING_FACTOR *
            (prediction.probability - previousScore);

    smoothedScores.set(label, nextScore);
  });

  return [...smoothedScores.entries()]
    .map(([label, probability]) => ({
      label,
      probability,
    }))
    .sort(
      (first, second) =>
        second.probability - first.probability
    )[0];
}

function updateStablePrediction(prediction) {
  if (
    !prediction ||
    prediction.probability < MINIMUM_CONFIDENCE
  ) {
    candidateLabel = null;
    candidateFrames = 0;

    setRecognitionStatus(
      "Looking for a clear animal shadow…",
      "ready"
    );

    return;
  }

  if (prediction.label === candidateLabel) {
    candidateFrames += 1;
  } else {
    candidateLabel = prediction.label;
    candidateFrames = 1;
  }

  if (candidateFrames >= REQUIRED_STABLE_PREDICTIONS) {
    const confidence = Math.round(
      prediction.probability * 100
    );

    setRecognitionStatus(
      `Detected: ${prediction.label} (${confidence}%)`,
      "detected"
    );
  } else {
    setRecognitionStatus(
      "Checking the shadow…",
      "ready"
    );
  }
}

async function runRecognition(timestamp, session) {
  if (
    !activeStream ||
    !imageModel ||
    session !== recognitionSession
  ) {
    return;
  }

  if (
    timestamp - lastPredictionTime <
    PREDICTION_INTERVAL_MS
  ) {
    recognitionFrameId = requestAnimationFrame(
      (nextTimestamp) =>
        runRecognition(nextTimestamp, session)
    );

    return;
  }

  if (
    camera.readyState <
    HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    recognitionFrameId = requestAnimationFrame(
      (nextTimestamp) =>
        runRecognition(nextTimestamp, session)
    );

    return;
  }

  lastPredictionTime = timestamp;

  try {
    const predictions = await imageModel.predict(camera);

    if (
      !activeStream ||
      session !== recognitionSession
    ) {
      return;
    }

    const topPrediction =
      getSmoothedTopPrediction(predictions);

    if (
      topPrediction &&
      topPrediction.probability >
        ANIMAL_SOUND_THRESHOLD
    ) {
      updateAnimalSound(
        topPrediction.label.trim().toLowerCase(),
        topPrediction.probability
      );
    } else {
      updateAnimalSound(null, 0);
    }

    updateStablePrediction(topPrediction);
  } catch (error) {
    if (session === recognitionSession) {
      stopAnimalSound();

      setRecognitionStatus(
        "Recognition paused — please restart the camera",
        "error"
      );
    }

    return;
  }

  recognitionFrameId = requestAnimationFrame(
    (nextTimestamp) =>
      runRecognition(nextTimestamp, session)
  );
}

function startRecognition() {
  if (!activeStream) return;

  if (!imageModel) {
    if (modelState === "loading") {
      setRecognitionStatus(
        "Loading animal model…"
      );
    }

    return;
  }

  cancelAnimationFrame(recognitionFrameId);

  recognitionSession += 1;
  const session = recognitionSession;

  lastPredictionTime = 0;
  resetRecognitionSmoothing();
  stopAnimalSound();

  setRecognitionStatus(
    "Looking for a clear animal shadow…",
    "ready"
  );

  recognitionFrameId = requestAnimationFrame(
    (timestamp) =>
      runRecognition(timestamp, session)
  );
}

function stopRecognition() {
  recognitionSession += 1;

  cancelAnimationFrame(recognitionFrameId);
  recognitionFrameId = null;

  resetRecognitionSmoothing();

  if (modelState === "ready") {
    setRecognitionStatus(
      "Animal model ready — start the camera",
      "ready"
    );
  }
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied";

    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found";

    case "NotReadableError":
    case "TrackStartError":
      return "Camera is busy in another app";

    default:
      return "Camera could not be started";
  }
}

async function requestCamera() {
  try {
    // Phones should use the rear camera to face the wall.
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "environment",
      },
    });
  } catch (error) {
    // Laptops and single-camera devices can fall back
    // to their available webcam.
    if (
      error?.name === "OverconstrainedError" ||
      error?.name === "ConstraintNotSatisfiedError" ||
      error?.name === "NotFoundError"
    ) {
      return navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }

    throw error;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus(
      "Camera is not supported",
      "error"
    );

    return;
  }

  if (!window.isSecureContext) {
    setCameraStatus(
      "Camera needs an HTTPS page",
      "error"
    );

    return;
  }

  if (activeStream) {
    stopCamera();
  }

  primeAnimalAudio();

  startButton.disabled = true;
  setCameraStatus("Starting camera…");

  try {
    activeStream = await requestCamera();

    camera.srcObject = activeStream;
    await camera.play();

    cameraPlaceholder.hidden = true;

    updateControls(true);

    const activeTrack =
      activeStream.getVideoTracks()[0];

    const facingMode =
      activeTrack?.getSettings?.().facingMode;

    setCameraStatus(
      facingMode === "environment"
        ? "Rear camera is on"
        : "Camera is on",
      "active"
    );

    startRecognition();
  } catch (error) {
    if (activeStream) {
      activeStream
        .getTracks()
        .forEach((track) => track.stop());
    }

    stopAnimalSound();

    activeStream = null;
    camera.srcObject = null;
    cameraPlaceholder.hidden = false;

    updateControls(false);

    setCameraStatus(
      cameraErrorMessage(error),
      "error"
    );
  }
}

function stopCamera() {
  stopRecognition();
  stopAnimalSound();

  if (activeStream) {
    activeStream
      .getTracks()
      .forEach((track) => track.stop());
  }

  activeStream = null;
  camera.srcObject = null;
  cameraPlaceholder.hidden = false;

  updateControls(false);

  setCameraStatus("Camera stopped");
}

startButton.addEventListener(
  "click",
  startCamera
);

stopButton.addEventListener(
  "click",
  stopCamera
);

window.addEventListener(
  "beforeunload",
  stopCamera
);

loadAnimalModel();