"use strict";

const camera = document.getElementById("camera");
const startButton = document.getElementById("startCamera");
const stopButton = document.getElementById("stopCamera");
const cameraStatus = document.getElementById("cameraStatus");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");

let activeStream = null;

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
      video: { facingMode: "environment" },
    });
  } catch (error) {
    // Laptops and single-camera devices can fall back to their available webcam.
    if (
      error?.name === "OverconstrainedError" ||
      error?.name === "ConstraintNotSatisfiedError" ||
      error?.name === "NotFoundError"
    ) {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    throw error;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("Camera is not supported", "error");
    return;
  }

  if (!window.isSecureContext) {
    setCameraStatus("Camera needs an HTTPS page", "error");
    return;
  }

  if (activeStream) stopCamera();

  startButton.disabled = true;
  setCameraStatus("Starting camera…");

  try {
    activeStream = await requestCamera();
    camera.srcObject = activeStream;
    await camera.play();

    cameraPlaceholder.hidden = true;
    updateControls(true);

    const activeTrack = activeStream.getVideoTracks()[0];
    const facingMode = activeTrack?.getSettings?.().facingMode;
    setCameraStatus(facingMode === "environment" ? "Rear camera is on" : "Camera is on", "active");
  } catch (error) {
    if (activeStream) activeStream.getTracks().forEach((track) => track.stop());

    activeStream = null;
    camera.srcObject = null;
    cameraPlaceholder.hidden = false;
    updateControls(false);
    setCameraStatus(cameraErrorMessage(error), "error");
  }
}

function stopCamera() {
  if (activeStream) activeStream.getTracks().forEach((track) => track.stop());

  activeStream = null;
  camera.srcObject = null;
  cameraPlaceholder.hidden = false;
  updateControls(false);
  setCameraStatus("Camera stopped");
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopCamera);
window.addEventListener("beforeunload", stopCamera);
