function getVideoContentRect(video) {
  const videoRect = video.getBoundingClientRect();
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  
  if (!videoWidth || !videoHeight) {
    return videoRect;
  }
  
  const videoRatio = videoWidth / videoHeight;
  const containerRatio = videoRect.width / videoRect.height;
  
  let actualWidth, actualHeight, actualLeft, actualTop;
  
  if (videoRatio > containerRatio) {
    actualWidth = videoRect.width;
    actualHeight = actualWidth / videoRatio;
    actualLeft = videoRect.left;
    actualTop = videoRect.top + (videoRect.height - actualHeight) / 2;
  } else {
    actualHeight = videoRect.height;
    actualWidth = actualHeight * videoRatio;
    actualLeft = videoRect.left + (videoRect.width - actualWidth) / 2;
    actualTop = videoRect.top;
  }
  
  return {
    left: actualLeft,
    top: actualTop,
    width: actualWidth,
    height: actualHeight,
    right: actualLeft + actualWidth,
    bottom: actualTop + actualHeight
  };
}

function updateInputsFromSubtitlePosition(left, top, dragWidth, dragHeight) {
  const video = $('studio-video-preview');
  
  if (!video) return;
  
  const W_act = video.videoWidth || 1080;
  const H_act = video.videoHeight || 1920;
  
  const stageW = konvaStage ? konvaStage.width() : W_act;
  const stageH = konvaStage ? konvaStage.height() : H_act;
  
  // 1. Determine quadrants based on stage coordinates
  const centerPercent = (left + dragWidth / 2) / stageW;
  const topPercent = top / stageH;
  
  let verticalSec = 'bottom';
  if (topPercent < 0.35) {
    verticalSec = 'top';
  } else if (topPercent > 0.65) {
    verticalSec = 'bottom';
  } else {
    verticalSec = 'middle';
  }
  
  let horizontalSec = 'center';
  if (centerPercent < 0.35) {
    horizontalSec = 'left';
  } else if (centerPercent > 0.65) {
    horizontalSec = 'right';
  } else {
    horizontalSec = 'center';
  }
  
  // 2. Select alignment
  let alignment = 2;
  if (verticalSec === 'bottom') {
    if (horizontalSec === 'left') alignment = 1;
    else if (horizontalSec === 'right') alignment = 3;
    else alignment = 2;
  } else if (verticalSec === 'top') {
    if (horizontalSec === 'left') alignment = 5;
    else if (horizontalSec === 'right') alignment = 7;
    else alignment = 6;
  } else {
    if (horizontalSec === 'left') alignment = 9;
    else if (horizontalSec === 'right') alignment = 11;
    else alignment = 10;
  }
  
  const alignmentInput = document.querySelector('[name="subtitleAlignment"]');
  if (alignmentInput) {
    alignmentInput.value = alignment;
    alignmentInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const alignGrid = $('alignment-visual-grid');
  if (alignGrid) {
    alignGrid.querySelectorAll('.grid-cell').forEach(cell => {
      cell.classList.toggle('active', Number(cell.dataset.align) === alignment);
    });
  }
  
  // 3. Compute vertical margin based on quadrant (Top vs Bottom) in stage coordinates, then scale to video coordinates
  let MarginV_act = 0;
  if (verticalSec === 'top') {
    MarginV_act = Math.round((top / stageH) * H_act);
  } else {
    MarginV_act = Math.round(((stageH - (top + dragHeight)) / stageH) * H_act);
  }
  
  // Compute horizontal margin in stage coordinates, then scale to video coordinates
  const marginL_act = left;
  const marginR_act = stageW - (left + dragWidth);
  const MarginH_act = Math.round((Math.min(marginL_act, marginR_act) / stageW) * W_act);
  const MarginL_act_scaled = Math.round((marginL_act / stageW) * W_act);
  const MarginR_act_scaled = Math.round((marginR_act / stageW) * W_act);
  
  const marginInput = document.querySelector('input[name="subtitleMargin"]');
  if (marginInput) {
    marginInput.value = Math.max(0, MarginV_act);
    marginInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
  if (marginHInput) {
    marginHInput.value = Math.max(0, MarginH_act);
    marginHInput.dataset.lastStageWidth = W_act;
    marginHInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Lưu marginL và marginR riêng biệt để khôi phục vị trí chính xác
  const marginLInput = document.querySelector('input[name="subtitleMarginL"]');
  if (marginLInput) {
    marginLInput.value = Math.max(0, MarginL_act_scaled);
  }
  const marginRInput = document.querySelector('input[name="subtitleMarginR"]');
  if (marginRInput) {
    marginRInput.value = Math.max(0, MarginR_act_scaled);
  }
}

function wrapTextToTwoLines(text, maxCharsPerLine = 22) {
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }

  const words = cleanText.split(' ');
  const midPoint = Math.floor(cleanText.length / 2);
  let bestIndex = -1;
  let minDiff = Infinity;
  
  let currentPos = 0;
  for (let i = 0; i < words.length - 1; i++) {
    currentPos += words[i].length + 1;
    const diff = Math.abs(currentPos - midPoint);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }

  if (bestIndex !== -1) {
    const line1 = words.slice(0, bestIndex + 1).join(' ');
    const line2 = words.slice(bestIndex + 1).join(' ');
    return `${line1}\n${line2}`;
  }

  return cleanText;
}

function wrapTextToThreeLines(text, maxCharsPerLine = 22) {
  const cleanText = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxCharsPerLine) {
    return cleanText;
  }
  if (cleanText.length <= maxCharsPerLine * 1.6) {
    return wrapTextToTwoLines(cleanText, maxCharsPerLine);
  }
  
  const words = cleanText.split(' ');
  if (words.length <= 2) {
    return words.join('\n');
  }
  
  const totalLen = cleanText.length;
  
  let bestI = -1;
  let bestJ = -1;
  let minVariance = Infinity;
  
  let posI = 0;
  for (let i = 0; i < words.length - 2; i++) {
    posI += words[i].length + 1;
    
    let posJ = posI;
    for (let j = i + 1; j < words.length - 1; j++) {
      posJ += words[j].length + 1;
      
      const len1 = posI - 1;
      const len2 = posJ - posI - 1;
      const len3 = totalLen - posJ;
      
      const mean = totalLen / 3;
      const variance = Math.pow(len1 - mean, 2) + Math.pow(len2 - mean, 2) + Math.pow(len3 - mean, 2);
      
      if (variance < minVariance) {
        minVariance = variance;
        bestI = i;
        bestJ = j;
      }
    }
  }
  
  if (bestI !== -1 && bestJ !== -1) {
    const line1 = words.slice(0, bestI + 1).join(' ');
    const line2 = words.slice(bestI + 1, bestJ + 1).join(' ');
    const line3 = words.slice(bestJ + 1).join(' ');
    return `${line1}\n${line2}\n${line3}`;
  }
  
  return cleanText;
}

function updateSubtitleOverlayFromInputs() {
  const video = $('studio-video-preview');
  const container = $('konva-stage-container');
  if (!video || !container) return;

  const applySnapping = (node, w, h, currentX, currentY) => {
    let x = currentX;
    let y = currentY;
    
    if (!konvaStage) return { x, y };
    
    const stageW = konvaStage.width();
    const stageH = konvaStage.height();
    
    const SNAP_THRESHOLD = 8;
    const stageCenterX = Math.round(stageW / 2);
    const stageCenterY = Math.round(stageH / 2);
    
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    
    let snappedX = false;
    let snappedY = false;
    
    if (Math.abs(centerX - stageCenterX) < SNAP_THRESHOLD) {
      x = stageCenterX - w / 2;
      snappedX = true;
    }
    
    if (Math.abs(centerY - stageCenterY) < SNAP_THRESHOLD) {
      y = stageCenterY - h / 2;
      snappedY = true;
    }
    
    // Cập nhật đường căn dọc
    if (vGuideline) {
      if (snappedX) {
        vGuideline.points([stageCenterX, 0, stageCenterX, stageH]);
        vGuideline.visible(true);
        vGuideline.moveToTop();
      } else {
        vGuideline.visible(false);
      }
    }
    
    // Cập nhật đường căn ngang
    if (hGuideline) {
      if (snappedY) {
        hGuideline.points([0, stageCenterY, stageW, stageCenterY]);
        hGuideline.visible(true);
        hGuideline.moveToTop();
      } else {
        hGuideline.visible(false);
      }
    }
    
    if (konvaLayer) {
      konvaLayer.draw();
    }
    
    return { x, y };
  };

  const hideGuidelines = () => {
    if (vGuideline) vGuideline.visible(false);
    if (hGuideline) hGuideline.visible(false);
    if (konvaLayer) konvaLayer.draw();
  };

  if (!video.src || video.src === '') {
    if (konvaStage) {
      konvaStage.destroy();
      konvaStage = null;
    }
    return;
  }

  const containerRect = video.parentElement.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) return;

  const videoRect = getVideoContentRect(video);
  const W_act = video.videoWidth || 1080;
  const H_act = video.videoHeight || 1920;
  const font_scale = videoRect.height / H_act;
  console.log(`[Overlay] updateSubtitleOverlayFromInputs: videoWidth=${video.videoWidth}, videoHeight=${video.videoHeight}, videoRect.height=${videoRect.height}, font_scale=${font_scale}`);

  // Căn chỉnh và tỷ lệ container của stage khớp chính xác với video đang hiển thị
  container.style.left = (videoRect.left - containerRect.left) + 'px';
  container.style.top = (videoRect.top - containerRect.top) + 'px';
  container.style.width = W_act + 'px';
  container.style.height = H_act + 'px';
  container.style.transform = `scale(${font_scale})`;
  container.style.transformOrigin = 'top left';
  container.style.pointerEvents = 'auto'; // Cho phép tương tác Konva Stage

  // Khởi tạo Stage và Layer nếu chưa có
  if (!konvaStage) {
    konvaStage = new Konva.Stage({
      container: 'konva-stage-container',
      width: W_act,
      height: H_act
    });

    konvaLayer = new Konva.Layer();
    konvaStage.add(konvaLayer);

    vGuideline = new Konva.Line({
      points: [0, 0, 0, 0],
      stroke: '#FF3B30',
      strokeWidth: 3,
      dash: [6, 6],
      visible: false,
      listening: false
    });
    hGuideline = new Konva.Line({
      points: [0, 0, 0, 0],
      stroke: '#FF3B30',
      strokeWidth: 3,
      dash: [6, 6],
      visible: false,
      listening: false
    });
    konvaLayer.add(vGuideline);
    konvaLayer.add(hGuideline);

    // 1. Phụ đề (Subtitle)
    konvaSubtitle = new Konva.Group({
      name: 'subtitle',
      draggable: true
    });
    
    const subText = new Konva.Text({
      id: 'sub-text',
      text: 'Phụ đề mẫu',
      fontSize: 18,
      fontFamily: 'Arial',
      fill: '#FFFFFF',
      align: 'center'
    });

    const subBg = new Konva.Rect({
      id: 'sub-bg',
      fill: 'transparent'
    });

    konvaSubtitle.add(subBg);
    konvaSubtitle.add(subText);
    konvaLayer.add(konvaSubtitle);

    // 2. Reaction PIP
    konvaReaction = new Konva.Group({
      name: 'reaction',
      draggable: true
    });

    const rxVideoElement = $('preview-reaction-video');
    const rxVideoImage = new Konva.Image({
      id: 'rx-video-image',
      image: rxVideoElement,
      draggable: false
    });

    const rxRect = new Konva.Rect({
      id: 'rx-rect',
      stroke: '#FF9800',
      strokeWidth: 4,
      fill: 'transparent',
      dash: [10, 5]
    });

    const rxText = new Konva.Text({
      id: 'rx-text',
      text: 'Reaction PIP (Kéo & Co giãn)',
      fontSize: 18,
      fontFamily: 'Arial',
      fill: '#FF9800',
      align: 'center',
      verticalAlign: 'middle'
    });

    konvaReaction.add(rxVideoImage);
    konvaReaction.add(rxRect);
    konvaReaction.add(rxText);
    konvaLayer.add(konvaReaction);

    // Vòng lặp vẽ lại liên tục khi video reaction chơi để cập nhật khung hình
    const rxAnim = new Konva.Animation(() => {}, konvaLayer);
    rxVideoElement.addEventListener('play', () => rxAnim.start());
    rxVideoElement.addEventListener('pause', () => rxAnim.stop());
    rxVideoElement.addEventListener('seeked', () => konvaLayer.batchDraw());
    if (!rxVideoElement.paused) {
      rxAnim.start();
    }

    // 3. Blur Box
    konvaBlur = new Konva.Shape({
      name: 'blur',
      draggable: true,
      stroke: '#00E5FF',
      strokeWidth: 4,
      fill: 'transparent',
      dash: [10, 5],
      sceneFunc: function (context, shape) {
        const ctx = context._context;
        const w = shape.width();
        const h = shape.height();
        
        ctx.save();
        
        // 1. Vẽ nội dung video đã làm mờ
        const mainVideo = $('studio-video-preview');
        if (mainVideo && mainVideo.readyState >= 2) {
          ctx.beginPath();
          ctx.rect(0, 0, w, h);
          ctx.clip();
          
          const x = shape.x();
          const y = shape.y();
          const radius = Number($('blur-radius-slider')?.value || 20);
          ctx.filter = `blur(${radius}px)`;
          
          ctx.drawImage(
            mainVideo,
            x, y, w, h,
            0, 0, w, h
          );
        } else {
          ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
          ctx.fillRect(0, 0, w, h);
        }
        
        ctx.restore();
        
        // 2. Vẽ viền nét đứt bên ngoài (không bị clip)
        context.fillStrokeShape(shape);
      }
    });
    konvaLayer.add(konvaBlur);

    // Vòng lặp vẽ lại liên tục khi video chính chơi để cập nhật khung hình mờ
    const mainAnim = new Konva.Animation(() => {}, konvaLayer);
    const mainVideoElement = $('studio-video-preview');
    mainVideoElement.addEventListener('play', () => mainAnim.start());
    mainVideoElement.addEventListener('pause', () => mainAnim.stop());
    mainVideoElement.addEventListener('seeked', () => konvaLayer.batchDraw());
    mainVideoElement.addEventListener('timeupdate', () => konvaLayer.batchDraw());
    if (!mainVideoElement.paused) {
      mainAnim.start();
    }

    // Transformer co giãn
    konvaTransformer = new Konva.Transformer({
      nodes: [],
      rotateEnabled: false,
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      boundBoxFunc: (oldBox, newBox) => {
        if (newBox.width < 50 || newBox.height < 20) {
          return oldBox;
        }
        return newBox;
      }
    });
    konvaLayer.add(konvaTransformer);

    // Xử lý sự kiện click trên Stage để chọn đối tượng hoặc chuyển tiếp click cho các control dưới canvas
    konvaStage.on('mousedown touchstart', (e) => {
      if (e.target === konvaStage) {
        konvaTransformer.nodes([]);
        konvaLayer.draw();

        // 1. Tạm thời cho phép click xuyên qua để tìm phần tử bên dưới
        container.style.pointerEvents = 'none';

        let clientX = e.evt.clientX;
        let clientY = e.evt.clientY;
        if (e.evt.touches && e.evt.touches[0]) {
          clientX = e.evt.touches[0].clientX;
          clientY = e.evt.touches[0].clientY;
        }

        let clickedEl = null;
        if (clientX !== undefined && clientY !== undefined) {
          clickedEl = document.elementFromPoint(clientX, clientY);
        }

        container.style.pointerEvents = 'auto';

        // 2. Chuyển tiếp sự kiện nếu click vào các control của safezone (mute, play/pause, timeline)
        if (clickedEl && (
          clickedEl.closest('.safezone-action-mute') ||
          clickedEl.closest('.safezone-action-playpause') ||
          clickedEl.closest('.safezone-timeline-container') ||
          clickedEl.tagName === 'INPUT' ||
          clickedEl.tagName === 'BUTTON'
        )) {
          const eventType = e.evt.type;
          let clonedEvent;
          if (typeof window.TouchEvent !== 'undefined' && e.evt instanceof TouchEvent) {
            clonedEvent = new TouchEvent(eventType, e.evt);
          } else {
            clonedEvent = new MouseEvent(eventType, e.evt);
          }
          clickedEl.dispatchEvent(clonedEvent);
        } else {
          // Play/Pause video nếu click ngoài vùng control
          const previewVideo = $('studio-video-preview');
          if (previewVideo && previewVideo.src) {
            if (previewVideo.paused) {
              previewVideo.play().catch(() => {});
            } else {
              previewVideo.pause();
            }
          }
        }
        return;
      }

      // Nếu click vào chính Transformer hoặc các anchor của nó, không thay đổi selection
      let isTransformer = false;
      let check = e.target;
      while (check && check !== konvaStage) {
        if (check === konvaTransformer) {
          isTransformer = true;
          break;
        }
        check = check.parent;
      }
      if (isTransformer) return;

      // Tìm đối tượng được chọn (Subtitle, Reaction, hoặc Blur)
      let clickedNode = null;
      let curr = e.target;
      while (curr && curr !== konvaStage) {
        if (curr.name() === 'subtitle' || curr.name() === 'reaction' || curr.name() === 'blur' || curr.name() === 'blur-box-shape') {
          clickedNode = curr;
          break;
        }
        curr = curr.parent;
      }

      if (clickedNode) {
        // Cấu hình các điểm neo transformer tùy thuộc vào đối tượng được chọn
        if (clickedNode.name() === 'blur' || clickedNode.name() === 'blur-box-shape') {
          if (clickedNode.name() === 'blur-box-shape') {
            const boxId = clickedNode.getAttr('boxId');
            if (boxId && boxId !== activeBlurBoxId) {
              selectBlurBox(boxId);
            }
          }
          konvaTransformer.enabledAnchors([
            'top-left', 'top-center', 'top-right',
            'middle-right',
            'bottom-right', 'bottom-center', 'bottom-left',
            'middle-left'
          ]);
        } else if (clickedNode.name() === 'subtitle') {
          // Phụ đề cho phép kéo góc và kéo cạnh bên (ngang) để chỉnh độ rộng khung chữ
          konvaTransformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right']);
        } else {
          // Reaction chỉ kéo góc để tránh méo tỷ lệ khung hình video
          konvaTransformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
        }
        konvaTransformer.nodes([clickedNode]);
        konvaLayer.draw();
      } else {
        konvaTransformer.nodes([]);
        konvaLayer.draw();
      }
    });

    // Kéo phụ đề
    konvaSubtitle.on('dragmove', () => {
      const subTextNode = konvaSubtitle.findOne('#sub-text');
      const w = subTextNode.width();
      const h = subTextNode.height();
      
      let x = konvaSubtitle.x();
      let y = konvaSubtitle.y();
      
      const stageW = konvaStage.width();
      const stageH = konvaStage.height();
      
      // Giới hạn trong khung hình trước khi hít
      x = Math.max(0, Math.min(x, stageW - w));
      y = Math.max(0, Math.min(y, stageH - h));
      
      // Tự bắt dính căn giữa
      const snapped = applySnapping(konvaSubtitle, w, h, x, y);
      x = snapped.x;
      y = snapped.y;
      
      konvaSubtitle.position({ x, y });

      updateInputsFromSubtitlePosition(x, y, w, h);
    });

    konvaSubtitle.on('dragend', () => {
      hideGuidelines();
    });

    // Co giãn phụ đề
    konvaSubtitle.on('transform', () => {
      const subTextNode = konvaSubtitle.findOne('#sub-text');
      let scaleX = konvaSubtitle.scaleX();
      let newW = subTextNode.width() * scaleX;
      
      const fontSizeInput = document.querySelector('input[name="subtitleSize"]');
      const fontSizeVal = fontSizeInput ? (parseInt(fontSizeInput.value) || 32) : 32;
      
      const stageW = konvaStage.width();
      let newMarginH = Math.round((stageW - newW) / 2);
      newMarginH = Math.max(10, Math.min(newMarginH, Math.floor(stageW / 2) - 50));
      
      const marginHInput = document.querySelector('input[name="subtitleMarginH"]');
      if (marginHInput) {
        marginHInput.value = newMarginH;
        marginHInput.dataset.lastStageWidth = stageW;
      }

      // Cập nhật marginL và marginR khi co giãn
      const marginLInput = document.querySelector('input[name="subtitleMarginL"]');
      const marginRInput = document.querySelector('input[name="subtitleMarginR"]');
      if (marginLInput) marginLInput.value = newMarginH;
      if (marginRInput) marginRInput.value = newMarginH;

      konvaSubtitle.scaleX(1);
      konvaSubtitle.scaleY(1);

      updateSubtitleOverlayFromInputs();
    });

    // Kéo & co giãn Reaction PIP
    konvaReaction.on('dragmove transform', () => {
      const rxRectNode = konvaReaction.findOne('#rx-rect');
      let scaleX = konvaReaction.scaleX();
      let scaleY = konvaReaction.scaleY();
      
      let w = rxRectNode.width() * scaleX;
      let h = rxRectNode.height() * scaleY;
      let x = konvaReaction.x();
      let y = konvaReaction.y();

      const stageW = konvaStage.width();
      const stageH = konvaStage.height();

      const minSize = 20;
      if (scaleX !== 1 || scaleY !== 1) {
        // Resizing - keep aspect ratio and clamp boundaries
        const aspect = w / h || 4 / 3;
        if (x < 0) {
          w = Math.max(minSize, w + x);
          h = w / aspect;
          x = 0;
        }
        if (y < 0) {
          h = Math.max(minSize, h + y);
          w = h * aspect;
          y = 0;
        }
        if (x + w > stageW) {
          w = Math.max(minSize, stageW - x);
          h = w / aspect;
        }
        if (y + h > stageH) {
          h = Math.max(minSize, stageH - y);
          w = h * aspect;
        }
      } else {
        // Dragging/moving - clamp position within active bounds
        x = Math.max(0, Math.min(x, stageW - w));
        y = Math.max(0, Math.min(y, stageH - h));

        // Tự bắt dính căn giữa
        const snapped = applySnapping(konvaReaction, w, h, x, y);
        x = snapped.x;
        y = snapped.y;
      }

      konvaReaction.position({ x, y });

      konvaReaction.scaleX(1);
      konvaReaction.scaleY(1);
      rxRectNode.width(w);
      rxRectNode.height(h);
      
      const rxVideoImageNode = konvaReaction.findOne('#rx-video-image');
      if (rxVideoImageNode) {
        rxVideoImageNode.width(w);
        rxVideoImageNode.height(h);
      }
      
      const rxTextNode = konvaReaction.findOne('#rx-text');
      rxTextNode.width(w);
      rxTextNode.height(h);

      const rxXInput = $('reaction-x');
      if (rxXInput) {
        rxXInput.value = Math.round(x);
        rxXInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const rxYInput = $('reaction-y');
      if (rxYInput) {
        rxYInput.value = Math.round(y);
        rxYInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
      const widthInput = document.querySelector('input[name="reactionWidth"]');
      if (widthInput) {
        widthInput.value = Math.round(w);
        const valSpan = $('reaction-width-val');
        if (valSpan) valSpan.textContent = widthInput.value + 'px';
        widthInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      $('preview-reaction-pip').dataset.customGeometry = 'true';
      const posSelect = document.querySelector('select[name="reactionPosition"]');
      if (posSelect) {
        posSelect.value = 'custom';
        posSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
      konvaLayer.draw();
    });

    konvaReaction.on('dragend', () => {
      hideGuidelines();
    });

    // Kéo & co giãn Blur Box
    konvaBlur.on('dragmove transform', () => {
      let scaleX = konvaBlur.scaleX();
      let scaleY = konvaBlur.scaleY();
      
      let w = konvaBlur.width() * scaleX;
      let h = konvaBlur.height() * scaleY;
      let x = konvaBlur.x();
      let y = konvaBlur.y();

      const stageW = konvaStage.width();
      const stageH = konvaStage.height();

      const minSize = 10;
      if (scaleX !== 1 || scaleY !== 1) {
        // Resizing - clamp position and size
        if (x < 0) {
          w = Math.max(minSize, w + x);
          x = 0;
        }
        if (y < 0) {
          h = Math.max(minSize, h + y);
          y = 0;
        }
        if (x + w > stageW) {
          w = Math.max(minSize, stageW - x);
        }
        if (y + h > stageH) {
          h = Math.max(minSize, stageH - y);
        }
      } else {
        // Dragging/moving - clamp position within active bounds
        x = Math.max(0, Math.min(x, stageW - w));
        y = Math.max(0, Math.min(y, stageH - h));

        // Tự bắt dính căn giữa
        const snapped = applySnapping(konvaBlur, w, h, x, y);
        x = snapped.x;
        y = snapped.y;
      }

      konvaBlur.position({ x, y });
      
      konvaBlur.scaleX(1);
      konvaBlur.scaleY(1);
      konvaBlur.width(w);
      konvaBlur.height(h);

      const blurX = Math.round((x / stageW) * 100);
      const blurY = Math.round((y / stageH) * 100);
      const blurW = Math.round((w / stageW) * 100);
      const blurH = Math.round((h / stageH) * 100);

      $('blur-x-input').value = Math.max(0, Math.min(100, blurX));
      $('blur-y-input').value = Math.max(0, Math.min(100, blurY));
      $('blur-width-input').value = Math.max(1, Math.min(100, blurW));
      $('blur-height-input').value = Math.max(1, Math.min(100, blurH));

      konvaLayer.draw();
    });

    konvaBlur.on('dragend', () => {
      hideGuidelines();
    });
  } else {
    konvaStage.width(W_act);
    konvaStage.height(H_act);
  }

  // 1. Cập nhật Phụ đề (Subtitle)
  const subTextNode = konvaSubtitle.findOne('#sub-text');
  const subBgNode = konvaSubtitle.findOne('#sub-bg');

  const textContentEl = $('subtitle-text-content');
  let rawText = 'Phụ đề mẫu';
  if (textContentEl && textContentEl.dataset.rawText) {
    rawText = textContentEl.dataset.rawText;
  }
  
  const fontSizeInput = Number(document.querySelector('input[name="subtitleSize"]').value || 32);
  
  const marginHEl = document.querySelector('input[name="subtitleMarginH"]');
  let marginHInput = Number(marginHEl ? marginHEl.value : 20) || 20;

  const maxLines = Number(document.querySelector('[name="subtitleMaxLines"]').value || 0);
  // Tính chiều ngang khung phụ đề: ưu tiên marginL+marginR nếu có
  const marginLHidden = document.querySelector('input[name="subtitleMarginL"]');
  const marginRHidden = document.querySelector('input[name="subtitleMarginR"]');
  let boxWidth;
  if (marginLHidden && marginRHidden && marginLHidden.value !== '' && marginRHidden.value !== '') {
    boxWidth = W_act - Number(marginLHidden.value) - Number(marginRHidden.value);
  } else {
    boxWidth = W_act - 2 * marginHInput;
  }
  boxWidth = Math.max(50, boxWidth);
  const maxChars = Math.max(10, Math.floor(boxWidth / (fontSizeInput * 0.5)));

  let wrappedText = rawText;
  if (maxLines === 1) {
    wrappedText = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  } else if (maxLines === 2) {
    wrappedText = wrapTextToTwoLines(rawText, maxChars);
  } else if (maxLines === 3) {
    wrappedText = wrapTextToThreeLines(rawText, maxChars);
  } else {
    const clean = rawText.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxChars) {
      wrappedText = clean;
    } else if (clean.length <= maxChars * 1.6) {
      wrappedText = wrapTextToTwoLines(clean, maxChars);
    } else {
      wrappedText = wrapTextToThreeLines(clean, maxChars);
    }
  }

  const scaleFactor = 1.35;
  const fontSize_canvas = fontSizeInput * scaleFactor;

  subTextNode.text(wrappedText);
  subTextNode.fontSize(fontSize_canvas);
  subTextNode.fontFamily(document.querySelector('select[name="subtitleFont"]').value || 'Arial');
  subTextNode.fontStyle(document.querySelector('select[name="subtitleBold"]').value === 'true' ? 'bold' : 'normal');
  subTextNode.width(boxWidth);

  const colorInput = document.querySelector('[name="subtitleColor"]').value || '#FFFFFF';
  const themeInput = document.querySelector('select[name="subtitleTheme"]').value || 'outline';

  subTextNode.fill(colorInput);
  subTextNode.stroke(null);
  subTextNode.strokeWidth(0);
  subTextNode.shadowEnabled(false);
  subBgNode.fill('transparent');

  if (themeInput === 'box') {
    subBgNode.fill('rgba(0, 0, 0, 0.6)');
    const paddingCanvas = 4.0 * scaleFactor;
    subBgNode.width(subTextNode.width() + paddingCanvas * 3);
    subBgNode.height(subTextNode.height() + paddingCanvas * 2);
    subBgNode.x(-paddingCanvas * 1.5);
    subBgNode.y(-paddingCanvas);
    subBgNode.cornerRadius(4 * scaleFactor);
  } else if (themeInput === 'box-deep') {
    subBgNode.fill('rgba(0, 0, 0, 0.95)');
    const paddingCanvas = 4.0 * scaleFactor;
    subBgNode.width(subTextNode.width() + paddingCanvas * 3);
    subBgNode.height(subTextNode.height() + paddingCanvas * 2);
    subBgNode.x(-paddingCanvas * 1.5);
    subBgNode.y(-paddingCanvas);
    subBgNode.cornerRadius(4 * scaleFactor);
  } else if (themeInput === 'shadow') {
    const shadowSize = 2 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(shadowSize * 2);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(0.8);
    subTextNode.shadowEnabled(true);
  } else if (themeInput === 'outline-thick') {
    subTextNode.stroke('black');
    subTextNode.strokeWidth(5.0 * scaleFactor);
  } else if (themeInput === 'outline-shadow') {
    subTextNode.stroke('black');
    subTextNode.strokeWidth(2.5 * scaleFactor);
    const shadowSize = 3 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(shadowSize * 1.3);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(0.8);
    subTextNode.shadowEnabled(true);
  } else if (themeInput === 'neon-glow') {
    subTextNode.fill('#FFFFFF');
    subTextNode.stroke(colorInput);
    subTextNode.strokeWidth(1.5 * scaleFactor);
    subTextNode.shadowColor(colorInput);
    subTextNode.shadowBlur(10 * scaleFactor);
    subTextNode.shadowOffset({ x: 0, y: 0 });
    subTextNode.shadowOpacity(1.0);
    subTextNode.shadowEnabled(true);
  } else if (themeInput === 'three-d') {
    subTextNode.stroke('black');
    subTextNode.strokeWidth(1.0 * scaleFactor);
    const shadowSize = 3 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(0);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(1.0);
    subTextNode.shadowEnabled(true);
  } else { // 'outline'
    subTextNode.stroke('black');
    subTextNode.strokeWidth(2.5 * scaleFactor);
    const shadowSize = 1 * scaleFactor;
    subTextNode.shadowColor('black');
    subTextNode.shadowBlur(shadowSize * 2);
    subTextNode.shadowOffset({ x: shadowSize, y: shadowSize });
    subTextNode.shadowOpacity(0.8);
    subTextNode.shadowEnabled(true);
  }

  const alignment = Number(document.querySelector('[name="subtitleAlignment"]').value || 2);
  const marginVInput = Number(document.querySelector('input[name="subtitleMargin"]').value || 28);

  // Đọc marginL và marginR riêng biệt (nếu có)
  const marginLEl = document.querySelector('input[name="subtitleMarginL"]');
  const marginREl = document.querySelector('input[name="subtitleMarginR"]');
  const hasCustomMargins = marginLEl && marginREl && marginLEl.value !== '' && marginREl.value !== '';
  const marginLInput = hasCustomMargins ? Number(marginLEl.value) : null;
  const marginRInput = hasCustomMargins ? Number(marginREl.value) : null;

  const stageW = konvaStage ? konvaStage.width() : W_act;
  const stageH = konvaStage ? konvaStage.height() : H_act;

  const marginVStage = (marginVInput / H_act) * stageH;

  let dragWidth, dragHeight;

  if (hasCustomMargins) {
    // Dùng marginL + marginR để tính chiều ngang chính xác
    const marginLStage = (marginLInput / W_act) * stageW;
    const marginRStage = (marginRInput / W_act) * stageW;
    dragWidth = Math.max(50, stageW - marginLStage - marginRStage);
    subTextNode.width(dragWidth);
    dragHeight = subTextNode.height();

    // Vị trí X: dùng marginL trực tiếp
    subX = marginLStage;
  } else {
    // Fallback cho dự án cũ: dùng marginH đối xứng
    const marginHStage = (marginHInput / W_act) * stageW;
    dragWidth = subTextNode.width();
    dragHeight = subTextNode.height();

    if ([1, 5, 9].includes(alignment)) {
      subX = marginHStage;
    } else if ([3, 7, 11].includes(alignment)) {
      subX = stageW - dragWidth - marginHStage;
    } else {
      subX = (stageW - dragWidth) / 2;
    }
  }

  // Vị trí Y: giữ logic cũ dựa trên alignment
  let subY = 0;
  if ([5, 6, 7].includes(alignment)) {
    subY = marginVStage;
  } else if ([9, 10, 11].includes(alignment)) {
    subY = (stageH - dragHeight) / 2;
  } else {
    subY = stageH - dragHeight - marginVStage;
  }

  konvaSubtitle.position({ x: subX, y: subY });
  console.log(`[Subtitle Position Debug] alignment=${alignment}, marginVInput=${marginVInput}, marginHInput=${marginHInput}, marginL=${marginLInput}, marginR=${marginRInput}, stageW=${stageW}, stageH=${stageH}, W_act=${W_act}, H_act=${H_act}, subX=${subX}, subY=${subY}`);
  
  const subMode = $('subtitle-mode').value;
  konvaSubtitle.visible(subMode !== 'none');

  // 2. Cập nhật Reaction PIP
  const rxMode = $('reaction-mode').value;
  if (!['upload', 'library'].includes(rxMode)) {
    konvaReaction.visible(false);
  } else {
    konvaReaction.visible(true);
    const rx = $('reaction-x').value;
    const ry = $('reaction-y').value;
    let widthInput = Number(document.querySelector('input[name="reactionWidth"]').value || 320);
    
    let ratio = 4 / 3;
    const reactionVid = $('preview-reaction-video');
    if (reactionVid && reactionVid.videoWidth && reactionVid.videoHeight) {
      ratio = reactionVid.videoHeight / reactionVid.videoWidth;
    }
    if (isNaN(ratio) || !isFinite(ratio) || ratio <= 0) {
      ratio = 4 / 3;
    }
    
    // Clamp width input to not exceed active video bounds
    widthInput = Math.max(20, Math.min(widthInput, W_act));
    let heightInput = widthInput * ratio;
    heightInput = Math.max(20, Math.min(heightInput, H_act));

    console.log(`[Overlay] Reaction PIP: rxMode=${rxMode}, rx=${rx}, ry=${ry}, width=${widthInput}, height=${heightInput}`);

    let rxX = rx !== '' ? Number(rx) : 0;
    let rxY = ry !== '' ? Number(ry) : 0;

    if (rx === '' || ry === '' || $('preview-reaction-pip').dataset.customGeometry !== 'true') {
      const position = document.querySelector('select[name="reactionPosition"]').value || 'bottom-right';
      const margin = 20;
      if (position === 'bottom-right') {
        rxX = W_act - widthInput - margin;
        rxY = H_act - heightInput - margin;
      } else if (position === 'bottom-left') {
        rxX = margin;
        rxY = H_act - heightInput - margin;
      } else if (position === 'top-right') {
        rxX = W_act - widthInput - margin;
        rxY = margin;
      } else if (position === 'top-left') {
        rxX = margin;
        rxY = margin;
      }
    }

    // Clamp coordinates to keep Reaction PIP fully within canvas
    rxX = Math.max(0, Math.min(rxX, W_act - widthInput));
    rxY = Math.max(0, Math.min(rxY, H_act - heightInput));

    konvaReaction.position({ x: rxX, y: rxY });
    
    const rxRectNode = konvaReaction.findOne('#rx-rect');
    rxRectNode.width(widthInput);
    rxRectNode.height(heightInput);
    rxRectNode.fill(reactionVid.src ? 'transparent' : 'rgba(255, 152, 0, 0.15)');

    const rxVideoImageNode = konvaReaction.findOne('#rx-video-image');
    if (rxVideoImageNode) {
      rxVideoImageNode.width(widthInput);
      rxVideoImageNode.height(heightInput);
    }

    const rxTextNode = konvaReaction.findOne('#rx-text');
    rxTextNode.width(widthInput);
    rxTextNode.height(heightInput);
    rxTextNode.visible(!reactionVid.src || reactionVid.src === '');
    
    // Update inputs to match clamped values
    $('reaction-x').value = Math.round(rxX);
    $('reaction-y').value = Math.round(rxY);
    const widthEl = document.querySelector('input[name="reactionWidth"]');
    if (widthEl) {
      widthEl.value = Math.round(widthInput);
      const valSpan = $('reaction-width-val');
      if (valSpan) valSpan.textContent = widthEl.value + 'px';
    }
  }

  // 3. Cập nhật các vùng làm mờ (Multiple Blur Boxes)
  if (konvaBlur) {
    konvaBlur.visible(false); // Ẩn blur box đơn lẻ cũ
  }

  const isBlurEnabled = true;
  const mainVideoElement = $('studio-video-preview');
  const currentTime = mainVideoElement ? mainVideoElement.currentTime : 0;

  // Xóa các vùng mờ không còn trong danh sách blurBoxes
  if (konvaLayer) {
    const existingShapes = konvaLayer.find('.blur-box-shape');
    existingShapes.forEach(shape => {
      const boxId = shape.getAttr('boxId');
      if (!blurBoxes.some(b => b.id === boxId)) {
        shape.destroy();
      }
    });
  }

  if (isBlurEnabled && konvaLayer) {
    blurBoxes.forEach((box, index) => {
      const shapeId = 'blur-box-' + box.id;
      let shape = konvaLayer.findOne('#' + shapeId);
      const isActive = activeBlurBoxId === box.id;

      // Xác định xem vùng mờ có hiển thị không
      // Hiển thị nếu: thời gian hiện tại nằm trong khoảng [start, end], HOẶC vùng mờ này đang được chỉnh sửa
      const isTimeActive = currentTime >= box.start && currentTime <= box.end;
      const shouldShow = isTimeActive || isActive;

      if (!shouldShow) {
        if (shape) {
          shape.visible(false);
          if (isActive && konvaTransformer.nodes().includes(shape)) {
            konvaTransformer.nodes([]);
          }
        }
        return;
      }

      // Đổi tọa độ phần trạng sang pixel trên canvas
      const blurX = (box.x / 100) * W_act;
      const blurY = (box.y / 100) * H_act;
      const blurW = (box.width / 100) * W_act;
      const blurH = (box.height / 100) * H_act;

      if (!shape) {
        shape = new Konva.Shape({
          id: shapeId,
          name: 'blur-box-shape',
          boxId: box.id,
          draggable: true,
          stroke: '#00E5FF',
          strokeWidth: 3,
          fill: 'transparent',
          dash: [8, 4],
          sceneFunc: function (context, shape) {
            const ctx = context._context;
            const w = shape.width();
            const h = shape.height();

            ctx.save();

            // Vẽ nội dung video đã làm mờ
            const mainVideo = $('studio-video-preview');
            if (mainVideo && mainVideo.readyState >= 2) {
              ctx.beginPath();
              ctx.rect(0, 0, w, h);
              ctx.clip();

              const x = shape.x();
              const y = shape.y();
              const radius = Number(box.radius || 20);
              ctx.filter = `blur(${radius}px)`;

              ctx.drawImage(
                mainVideo,
                x, y, w, h,
                0, 0, w, h
              );
            } else {
              ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
              ctx.fillRect(0, 0, w, h);
            }

            ctx.restore();

            // Vẽ viền ngoài
            context.fillStrokeShape(shape);
          }
        });

        // Bắt sự kiện kéo thả/co giãn
        shape.on('dragmove transform', () => {
          const currentBox = blurBoxes.find(b => b.id === box.id);
          if (!currentBox) return;

          let scaleX = shape.scaleX();
          let scaleY = shape.scaleY();

          let w = shape.width() * scaleX;
          let h = shape.height() * scaleY;
          let x = shape.x();
          let y = shape.y();

          const stageW = konvaStage.width();
          const stageH = konvaStage.height();

          const minSize = 10;
          if (scaleX !== 1 || scaleY !== 1) {
            // Đang co giãn
            if (x < 0) {
              w = Math.max(minSize, w + x);
              x = 0;
            }
            if (y < 0) {
              h = Math.max(minSize, h + y);
              y = 0;
            }
            if (x + w > stageW) {
              w = Math.max(minSize, stageW - x);
            }
            if (y + h > stageH) {
              h = Math.max(minSize, stageH - y);
            }
          } else {
            // Đang kéo thả
            x = Math.max(0, Math.min(x, stageW - w));
            y = Math.max(0, Math.min(y, stageH - h));

            // Bắt dính căn giữa
            const snapped = applySnapping(shape, w, h, x, y);
            x = snapped.x;
            y = snapped.y;
          }

          shape.position({ x, y });
          shape.scaleX(1);
          shape.scaleY(1);
          shape.width(w);
          shape.height(h);

          // Cập nhật giá trị vào object
          currentBox.x = Math.max(0, Math.min(100, Math.round((x / stageW) * 100)));
          currentBox.y = Math.max(0, Math.min(100, Math.round((y / stageH) * 100)));
          currentBox.width = Math.max(1, Math.min(100, Math.round((w / stageW) * 100)));
          currentBox.height = Math.max(1, Math.min(100, Math.round((h / stageH) * 100)));

          // Đồng bộ trực tiếp giá trị lên giao diện (không render lại danh sách để tránh mất focus)
          const itemEl = document.querySelector(`.blur-box-item[data-id="${currentBox.id}"]`);
          if (itemEl) {
            const xInput = itemEl.querySelector('input[data-field="x"]');
            const yInput = itemEl.querySelector('input[data-field="y"]');
            const wInput = itemEl.querySelector('input[data-field="width"]');
            const hInput = itemEl.querySelector('input[data-field="height"]');
            if (xInput) xInput.value = currentBox.x;
            if (yInput) yInput.value = currentBox.y;
            if (wInput) wInput.value = currentBox.width;
            if (hInput) hInput.value = currentBox.height;
          }

          konvaLayer.draw();
        });

        shape.on('dragend', () => {
          hideGuidelines();
        });

        konvaLayer.add(shape);
      }

      // Cập nhật các thuộc tính của shape
      shape.visible(true);
      shape.position({ x: blurX, y: blurY });
      shape.width(blurW);
      shape.height(blurH);
      shape.stroke(isActive ? 'var(--accent)' : '#00E5FF');
      shape.strokeWidth(isActive ? 4 : 2);

      // Nếu đang active, đưa vào transformer
      if (isActive) {
        const currentNodes = konvaTransformer.nodes();
        const isEditingOther = currentNodes.length > 0 && 
                               (currentNodes[0].name() === 'subtitle' || currentNodes[0].name() === 'reaction');
        
        if (!isEditingOther && !currentNodes.includes(shape)) {
          konvaTransformer.enabledAnchors([
            'top-left', 'top-center', 'top-right',
            'middle-right',
            'bottom-right', 'bottom-center', 'bottom-left',
            'middle-left'
          ]);
          konvaTransformer.nodes([shape]);
          shape.moveToTop();
          konvaTransformer.moveToTop();
        }
      }
    });
  } else {
    // Nếu tắt làm mờ hoặc layer chưa được tạo, ẩn toàn bộ shapes vùng mờ
    if (konvaLayer) {
      konvaLayer.find('.blur-box-shape').forEach(shape => {
        shape.visible(false);
      });
    }
  }

  // Đảm bảo thứ tự hiển thị (Z-Index): Blur box dưới cùng -> Reaction PIP -> Phụ đề -> Đường căn -> Transformer
  if (konvaLayer) {
    konvaLayer.find('.blur-box-shape').forEach(shape => {
      shape.moveToBottom();
    });
    if (konvaReaction) {
      konvaReaction.moveToTop();
    }
    if (konvaSubtitle) {
      konvaSubtitle.moveToTop();
    }
    if (vGuideline) vGuideline.moveToTop();
    if (hGuideline) hGuideline.moveToTop();
    if (konvaTransformer) {
      konvaTransformer.moveToTop();
    }
  }

  konvaLayer.draw();
}

function updateBlurBoxPreview() {
  updateSubtitleOverlayFromInputs();
}

// --- MULTIPLE TIMED BLUR BOXES LOGIC ---
function addBlurBox() {
  const newBox = {
    id: Date.now(),
    x: 10,
    y: 75,
    width: 80,
    height: 15,
    radius: 20,
    start: 0,
    end: 99999
  };
  blurBoxes.push(newBox);
  activeBlurBoxId = newBox.id;



  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

function removeBlurBox(id) {
  blurBoxes = blurBoxes.filter(b => b.id !== id);
  if (activeBlurBoxId === id) {
    activeBlurBoxId = blurBoxes.length > 0 ? blurBoxes[0].id : null;
  }
  renderBlurBoxesList();
  updateSubtitleOverlayFromInputs();
}

function selectBlurBox(id) {
  activeBlurBoxId = id;
  
  // 1. Update active class and styles on the list items directly
  document.querySelectorAll('.blur-box-item').forEach(item => {
    const itemId = parseInt(item.dataset.id);
    const isActive = itemId === id;
    item.classList.toggle('active', isActive);
    
    // Update container style inline
    item.style.background = isActive ? 'rgba(37, 99, 235, 0.05)' : '#10161d';
    item.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    
    // Update title span text and color
    const titleSpan = item.querySelector('span');
    if (titleSpan) {
      const match = titleSpan.textContent.match(/Vùng mờ\s+#(\d+)/);
      if (match) {
        const num = match[1];
        titleSpan.textContent = `Vùng mờ #${num} ${isActive ? '(Đang chỉnh)' : ''}`;
      }
      titleSpan.style.color = isActive ? 'var(--accent)' : 'var(--text)';
    }
  });

  // 2. Update active class on timeline blocks
  document.querySelectorAll('.timeline-block').forEach(block => {
    const blockId = parseInt(block.dataset.id);
    block.classList.toggle('active', blockId === id);
  });
  
  // 3. Update Konva stage selection
  updateSubtitleOverlayFromInputs();
}

function renderBlurBoxesList() {
  const container = $('blur-boxes-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (blurBoxes.length === 0) {
    container.innerHTML = `<div style="text-align: center; padding: 12px; color: var(--muted); font-size: 12px;">Chưa có vùng làm mờ nào. Nhấn "Thêm vùng mờ" để bắt đầu.</div>`;
    if (typeof renderTimeline === 'function') {
      renderTimeline();
    }
    return;
  }
  
  blurBoxes.forEach((box, index) => {
    const isActive = activeBlurBoxId === box.id;
    const item = document.createElement('div');
    item.className = `blur-box-item ${isActive ? 'active' : ''}`;
    item.dataset.id = box.id;
    item.style = `margin-top: 10px; padding: 10px; background: ${isActive ? 'rgba(37, 99, 235, 0.05)' : '#10161d'}; border: 1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}; border-radius: 6px; cursor: pointer; transition: all 0.2s ease;`;
    
    // Switch to this box on click (unless clicking inside input or delete button)
    item.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
        selectBlurBox(box.id);
      }
    });

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-size: 12px; font-weight: 700; color: ${isActive ? 'var(--accent)' : 'var(--text)'};">Vùng mờ #${index + 1} ${isActive ? '(Đang chỉnh)' : ''}</span>
        <button type="button" class="ghost-btn" style="padding: 2px 6px; font-size: 11px; color: var(--danger); border-color: rgba(239,68,68,0.2); background: transparent; height: auto;" onclick="event.stopPropagation(); removeBlurBox(${box.id})">Xóa</button>
      </div>
      
      <!-- Hidden coordinates to prevent JS code crash -->
      <div style="display: none;">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="x" value="${box.x}">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="y" value="${box.y}">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="width" value="${box.width}">
        <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="height" value="${box.height}">
      </div>

      <!-- Time bounds & blur slider settings -->
      <div class="sub-settings-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
        <div class="form-group" style="margin: 0;">
          <label style="font-size: 10px; margin: 0 0 2px 0; font-weight: 600;">Bắt đầu (s)</label>
          <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="start" value="${box.start}" min="0" step="any" style="padding: 4px 6px; height: 32px;">
        </div>
        <div class="form-group" style="margin: 0;">
          <label style="font-size: 10px; margin: 0 0 2px 0; font-weight: 600;">Kết thúc (s)</label>
          <input type="number" class="premium-input blur-input" data-id="${box.id}" data-field="end" value="${box.end}" min="0" step="any" style="padding: 4px 6px; height: 32px;">
        </div>
      </div>
      
      <!-- Blur Radius Slider -->
      <div class="form-group" style="margin: 8px 0 0 0; display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <label style="font-size: 10px; margin: 0; font-weight: 600;">Độ mờ (Radius)</label>
          <span id="radius-val-${box.id}" style="color: var(--accent); font-weight: 700; font-size: 11px;">${box.radius || 20}px</span>
        </div>
        <input type="range" class="premium-slider blur-input" data-id="${box.id}" data-field="radius" value="${box.radius || 20}" min="1" max="50" step="1" style="width: 100%; margin: 2px 0; cursor: pointer;" oninput="document.getElementById('radius-val-${box.id}').textContent = this.value + 'px'">
      </div>
    `;
    container.appendChild(item);
  });

  // Bind change event to input fields
  document.querySelectorAll('.blur-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const id = parseInt(e.target.dataset.id);
      const field = e.target.dataset.field;
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 0;
      
      const box = blurBoxes.find(b => b.id === id);
      if (box) {
        box[field] = val;
        // Limit bounds
        if (field === 'x' && box.x + box.width > 100) box.width = 100 - box.x;
        if (field === 'width' && box.x + box.width > 100) box.x = 100 - box.width;
        if (field === 'y' && box.y + box.height > 100) box.height = 100 - box.y;
        if (field === 'height' && box.y + box.height > 100) box.y = 100 - box.height;
        
        // Re-draw preview
        updateSubtitleOverlayFromInputs();
        if (typeof renderTimeline === 'function') {
          renderTimeline();
        }
      }
    });
  });

  if (typeof renderTimeline === 'function') {
    renderTimeline();
  }
}

// --- INTERACTIVE VISUAL EDITING TIMELINE LOGIC ---

function syncBoxInputs(box) {
  const video = $('studio-video-preview');
  const duration = video ? (video.duration || 0) : 0;
  
  document.querySelectorAll(`.blur-input[data-id="${box.id}"]`).forEach(input => {
    const field = input.dataset.field;
    if (field === 'start') {
      input.value = Number(box.start).toFixed(1);
    } else if (field === 'end') {
      input.value = box.end === 99999 ? (duration > 0 ? duration.toFixed(1) : 99999) : Number(box.end).toFixed(1);
    }
  });
}

function syncPlayhead() {
  const video = $('studio-video-preview');
  if (!video || !video.duration) return;
  
  const duration = video.duration;
  const timeLabel = $('timeline-time-label');
  if (timeLabel) {
    timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
  }
  
  const ruler = $('timeline-ruler');
  if (ruler) {
    const rulerWidth = ruler.clientWidth;
    const playhead = $('timeline-playhead');
    if (playhead && rulerWidth > 0) {
      const playheadLeft = (video.currentTime / duration) * rulerWidth;
      playhead.style.left = `${playheadLeft}px`;
    }
  }
}

function renderTimeline() {
  const video = $('studio-video-preview');
  if (!video || !video.duration) return;
  
  const duration = video.duration;
  const ruler = $('timeline-ruler');
  if (!ruler) return;
  const rulerWidth = ruler.clientWidth;
  if (rulerWidth === 0) return; // Not visible/rendered yet
  
  // 1. Draw ruler ticks and labels
  ruler.innerHTML = '';
  
  let tickInterval = 1;
  let labelInterval = 5;
  if (duration <= 30) {
    tickInterval = 1;
    labelInterval = 5;
  } else if (duration <= 120) {
    tickInterval = 5;
    labelInterval = 10;
  } else if (duration <= 600) {
    tickInterval = 10;
    labelInterval = 60;
  } else {
    tickInterval = 30;
    labelInterval = 120;
  }
  
  for (let t = 0; t <= duration; t += tickInterval) {
    const leftPx = (t / duration) * rulerWidth;
    const isMajor = (t % labelInterval === 0);
    
    const tick = document.createElement('div');
    tick.className = `timeline-ruler-tick ${isMajor ? 'major' : ''}`;
    tick.style.left = `${leftPx}px`;
    ruler.appendChild(tick);
    
    if (isMajor) {
      const label = document.createElement('div');
      label.className = 'timeline-ruler-label';
      label.style.left = `${leftPx}px`;
      label.textContent = formatTime(t);
      ruler.appendChild(label);
    }
  }
  
  // 2. Draw capsules on blur-track
  const blurTrack = $('blur-track');
  if (blurTrack) {
    blurTrack.innerHTML = '';
    
    blurBoxes.forEach((box, index) => {
      const isSelected = activeBlurBoxId === box.id;
      const block = document.createElement('div');
      block.className = `timeline-block ${isSelected ? 'active' : ''}`;
      block.dataset.id = box.id;
      
      const start = Math.max(0, Math.min(duration, box.start));
      const end = Math.max(start, Math.min(duration, box.end === 99999 ? duration : box.end));
      
      const leftPx = (start / duration) * rulerWidth;
      const rightPx = (end / duration) * rulerWidth;
      const widthPx = Math.max(15, rightPx - leftPx);
      
      block.style.left = `${leftPx}px`;
      block.style.width = `${widthPx}px`;
      
      block.innerHTML = `
        <div class="timeline-resize-handle left-handle"></div>
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; pointer-events: none; user-select: none;">Vùng mờ #${index + 1} (${start.toFixed(1)}s-${end.toFixed(1)}s)</span>
        <div class="timeline-resize-handle right-handle"></div>
      `;
      
      block.addEventListener('click', (e) => {
        if (!block.dataset.dragging && !block.dataset.resizing) {
          selectBlurBox(box.id);
        }
      });
      
      block.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        
        selectBlurBox(box.id);
        
        const initialClientX = e.clientX;
        const initialStart = box.start;
        const initialEnd = box.end === 99999 ? duration : box.end;
        const handle = e.target;
        const isLeftResize = handle.classList.contains('left-handle');
        const isRightResize = handle.classList.contains('right-handle');
        const isMove = !isLeftResize && !isRightResize;
        
        if (isLeftResize) block.dataset.resizing = 'left';
        if (isRightResize) block.dataset.resizing = 'right';
        if (isMove) block.dataset.dragging = 'true';
        
        let lastMoveEvent = null;
        let animationFrameId = null;
        let seekTimeout = null;
        
        const seekVideoDebounced = (time) => {
          if (seekTimeout) {
            clearTimeout(seekTimeout);
          }
          seekTimeout = setTimeout(() => {
            video.currentTime = time;
          }, 80);
        };
        
        const onMouseMove = (moveEvent) => {
          lastMoveEvent = moveEvent;
          
          if (!animationFrameId) {
            animationFrameId = requestAnimationFrame(() => {
              if (lastMoveEvent) {
                const deltaX = lastMoveEvent.clientX - initialClientX;
                const deltaSec = (deltaX / rulerWidth) * duration;
                
                if (isMove) {
                  let newStart = initialStart + deltaSec;
                  let newEnd = initialEnd + deltaSec;
                  const diff = newEnd - newStart;
                  if (newStart < 0) {
                    newStart = 0;
                    newEnd = diff;
                  }
                  if (newEnd > duration) {
                    newEnd = duration;
                    newStart = duration - diff;
                  }
                  box.start = Number(newStart.toFixed(3));
                  box.end = Number(newEnd.toFixed(3));
                  seekVideoDebounced(box.start);
                } else if (isLeftResize) {
                  let newStart = initialStart + deltaSec;
                  if (newStart < 0) newStart = 0;
                  if (newStart > initialEnd - 0.2) newStart = initialEnd - 0.2;
                  box.start = Number(newStart.toFixed(3));
                  seekVideoDebounced(box.start);
                } else if (isRightResize) {
                  let newEnd = initialEnd + deltaSec;
                  if (newEnd > duration) newEnd = duration;
                  if (newEnd < initialStart + 0.2) newEnd = initialStart + 0.2;
                  box.end = Number(newEnd.toFixed(3));
                  seekVideoDebounced(box.end === 99999 ? duration : box.end);
                }
                
                // Fast UI updates
                const finalStart = box.start;
                const finalEnd = box.end === 99999 ? duration : box.end;
                block.style.left = `${(finalStart / duration) * rulerWidth}px`;
                block.style.width = `${Math.max(15, ((finalEnd - finalStart) / duration) * rulerWidth)}px`;
                const textSpan = block.querySelector('span');
                if (textSpan) {
                  textSpan.textContent = `Vùng mờ #${index + 1} (${finalStart.toFixed(1)}s-${finalEnd.toFixed(1)}s)`;
                }
                
                syncBoxInputs(box);
                updateSubtitleOverlayFromInputs();
              }
              animationFrameId = null;
            });
          }
        };
        
        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          
          if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }
          if (seekTimeout) {
            clearTimeout(seekTimeout);
            seekTimeout = null;
          }
          
          // Final instant seek on release
          const finalTime = isRightResize ? (box.end === 99999 ? duration : box.end) : box.start;
          video.currentTime = finalTime;
          
          setTimeout(() => {
            delete block.dataset.dragging;
            delete block.dataset.resizing;
          }, 50);
          
          renderBlurBoxesList();
        };
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
      
      blurTrack.appendChild(block);
    });
  }
  
  syncPlayhead();
}

function initTimelineControls() {
  const video = $('studio-video-preview');
  const ruler = $('timeline-ruler');
  if (!video || !ruler) return;
  
  const playBtn = $('timeline-play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (video.paused) {
        video.play().catch(err => console.log("Play interrupted:", err));
      } else {
        video.pause();
      }
    });
  }
  
  video.addEventListener('play', () => {
    if (playBtn) {
      playBtn.textContent = 'Tạm dừng';
      playBtn.classList.add('playing');
    }
  });
  video.addEventListener('pause', () => {
    if (playBtn) {
      playBtn.textContent = 'Phát';
      playBtn.classList.remove('playing');
    }
  });
  
  video.addEventListener('timeupdate', () => {
    syncPlayhead();
  });
  
  let lastScrubEvent = null;
  let scrubFrameId = null;
  
  const seekToPosition = (e) => {
    lastScrubEvent = e;
    
    if (!scrubFrameId) {
      scrubFrameId = requestAnimationFrame(() => {
        if (lastScrubEvent) {
          const rect = ruler.getBoundingClientRect();
          const clickX = lastScrubEvent.clientX - rect.left;
          const percent = Math.max(0, Math.min(1, clickX / rect.width));
          if (video.duration) {
            video.currentTime = percent * video.duration;
            syncPlayhead();
          }
        }
        scrubFrameId = null;
      });
    }
  };
  
  ruler.addEventListener('mousedown', (e) => {
    e.preventDefault();
    seekToPosition(e);
    
    const onMouseMove = (moveEvent) => {
      seekToPosition(moveEvent);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (scrubFrameId) {
        cancelAnimationFrame(scrubFrameId);
        scrubFrameId = null;
      }
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  
  window.addEventListener('resize', () => {
    renderTimeline();
  });
}

