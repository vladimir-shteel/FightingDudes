// Generic pointer-based drag helper used for both fortress buildings and workers.
// NOT native HTML5 drag-and-drop: pointer events work identically for mouse and touch,
// let us render our own "ghost" in #fxLayer, and let the drop be cancelled by simply
// releasing the pointer anywhere (nothing under the cursor = no state change).
//
// Usage: attachDrag(element, {
//   getPayload(event)   -> payload object, or null/undefined to refuse the drag right now
//   createGhost(payload, sourceEl) -> element (optional; default clones the source element)
//   onDragStart(payload, event)
//   onDragMove(payload, event, targetEl) — targetEl = element under the pointer (hit-tested)
//   onDragEnd(payload, event, targetEl)  — only fires after a real drag (past the threshold)
//   onDragCancel(payload)                — pointer was cancelled (e.g. incoming call / scroll steal)
// })
//
// A tap that never crosses the DRAG_THRESHOLD_PX never enters drag mode, so all existing
// click/tap handlers (popovers, popups) keep working unchanged. After a real drag the
// following click event is swallowed, so drop handlers don't double-fire as "open popup".

const DRAG_THRESHOLD_PX = 8;

function suppressNextClick() {
  const swallow = (event) => {
    event.stopPropagation();
    event.preventDefault();
    cleanup();
  };
  const cleanup = () => {
    document.removeEventListener("click", swallow, true);
  };
  document.addEventListener("click", swallow, true);
  window.setTimeout(cleanup, 500);
}

export function attachDrag(element, handlers) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let ghost = null;

  element.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    const payload = handlers.getPayload?.(event);
    if (!payload) {
      return;
    }

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragging = false;

    const clearGhost = () => {
      ghost?.remove();
      ghost = null;
    };

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      if (!dragging) {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (distance < DRAG_THRESHOLD_PX) {
          return;
        }
        dragging = true;
        ghost = handlers.createGhost ? handlers.createGhost(payload, element) : element.cloneNode(true);
        const sourceRect = element.getBoundingClientRect();
        ghost.classList.add("drag-ghost");
        ghost.style.width = `${sourceRect.width}px`;
        ghost.style.height = `${sourceRect.height}px`;
        document.getElementById("fxLayer").append(ghost);
        element.classList.add("is-drag-source");
        handlers.onDragStart?.(payload, moveEvent);
      }
      moveEvent.preventDefault();
      ghost.style.left = `${moveEvent.clientX}px`;
      ghost.style.top = `${moveEvent.clientY}px`;
      const targetEl = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      handlers.onDragMove?.(payload, moveEvent, targetEl);
    };

    const finish = (endEvent, cancelled) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      const wasDragging = dragging;
      dragging = false;
      pointerId = null;
      clearGhost();
      element.classList.remove("is-drag-source");
      if (!wasDragging) {
        return;
      }
      suppressNextClick();
      if (cancelled) {
        handlers.onDragCancel?.(payload);
        return;
      }
      const targetEl = document.elementFromPoint(endEvent.clientX, endEvent.clientY);
      handlers.onDragEnd?.(payload, endEvent, targetEl);
    };

    const onUp = (upEvent) => {
      if (upEvent.pointerId === pointerId) {
        finish(upEvent, false);
      }
    };
    const onCancel = (cancelEvent) => {
      if (cancelEvent.pointerId === pointerId) {
        finish(cancelEvent, true);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  });
}
