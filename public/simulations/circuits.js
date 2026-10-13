// Physics, canvas drawing, and control bindings only. Page structure is owned by the shell.
export function mount(ui) {
    const document = ui;
'use strict';

// ═══ Canvas & State ═══
const canvas = document.getElementById('circuitCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const T = SimLib.Theme.use('light');

// Grid
const GRID = 20;
const COLS = 40, ROWS = 26;

// Component types and their snap-to positions
let components = [];
let wires = [];   // each wire: {x1,y1,x2,y2}
let selectedTool = 'battery';
let selectedComp = null;
let isDragging = false;
let dragOffsetX = 0, dragOffsetY = 0;
let hoveredComp = null;
let draggingWire = null; // {from: comp, sx, sy, ex, ey}

// Battery voltage
let batteryVoltage = 9.0;

// ═══ Grid helpers ═══
function snapToGrid(x, y) {
    return {
        x: Math.round(x / GRID) * GRID,
        y: Math.round(y / GRID) * GRID
    };
}

function gridKey(x, y) {
    return (x / GRID) + ',' + (y / GRID);
}

function getCanvasPos(e) {
    return SimLib.CanvasUtils.eventPos(canvas, e);
}

// ═══ Component Logic ═══
function createComponent(type, gx, gy) {
    const id = Date.now() + Math.random();
    const base = {
        id, type, gx, gy,
        resistance: type === 'resistor' ? 100 : type === 'bulb' ? 50 : type === 'wire' ? 0.1 : 0,
        switchClosed: type === 'switch' ? true : null,
    };
    return base;
}

function addComponent(type, gx, gy) {
    const snap = {x: gx, y: gy};
    // Don't place on existing component
    if (findCompAt(snap.x, snap.y)) return null;
    const comp = createComponent(type, snap.x, snap.y);
    if (type === 'battery') {
        // Only one battery allowed
        const existing = components.filter(c => c.type === 'battery');
        if (existing.length >= 1) return null;
    }
    components.push(comp);
    // Auto-wire adjacent components for convenience
    autoWire(comp);
    return comp;
}

function findCompAt(gx, gy) {
    return components.find(c => c.gx === gx && c.gy === gy);
}

function deleteCompAt(gx, gy) {
    const idx = components.findIndex(c => c.gx === gx && c.gy === gy);
    if (idx >= 0) {
        const removed = components[idx];
        components.splice(idx, 1);
        // Remove wires connected to this component
        wires = wires.filter(w => {
            const a = w.compA, b = w.compB;
            return !(a && a.id === removed.id) && !(b && b.id === removed.id);
        });
        return removed;
    }
    return null;
}

function autoWire(comp) {
    // Find adjacent components within 2 grid cells to auto-wire
    const directions = [
        {dx: 0, dy: -2}, {dx: 0, dy: -4},   // above
        {dx: 0, dy: 2},  {dx: 0, dy: 4},    // below
        {dx: 2, dy: 0},  {dx: 4, dy: 0},    // right
        {dx: -2, dy: 0}, {dx: -4, dy: 0},   // left
    ];
    for (const dir of directions) {
        const nx = comp.gx + dir.dx * GRID;
        const ny = comp.gy + dir.dy * GRID;
        const neighbor = findCompAt(nx, ny);
        if (neighbor && neighbor.id !== comp.id) {
            // Check if already wired
            const already = wires.find(w =>
                (w.compA && w.compA.id === comp.id && w.compB && w.compB.id === neighbor.id) ||
                (w.compA && w.compA.id === neighbor.id && w.compB && w.compB.id === comp.id)
            );
            if (!already && comp.type !== 'wire' && neighbor.type !== 'wire') {
                wires.push({ compA: comp, compB: neighbor });
            }
        }
    }
}

// ═══ Circuit Analysis ═══
function analyzeCircuit() {
    // Build adjacency graph from wires
    const adj = new Map();
    for (const c of components) adj.set(c.id, []);

    for (const w of wires) {
        if (w.compA && w.compB) {
            adj.get(w.compA.id).push(w.compB.id);
            adj.get(w.compB.id).push(w.compA.id);
        }
    }

    // Find the battery
    const battery = components.find(c => c.type === 'battery');
    if (!battery) return { req: 0, current: 0, power: 0, hasBattery: false, shortCircuit: false };

    // BFS from battery to find all connected components
    const visited = new Set();
    const queue = [battery.id];
    visited.add(battery.id);
    while (queue.length > 0) {
        const cur = queue.shift();
        for (const nid of (adj.get(cur) || [])) {
            if (!visited.has(nid)) {
                visited.add(nid);
                queue.push(nid);
            }
        }
    }

    const connected = components.filter(c => visited.has(c.id));

    // Check for switches
    const openSwitches = connected.filter(c => c.type === 'switch' && !c.switchClosed);
    if (openSwitches.length > 0) {
        return { req: Infinity, current: 0, power: 0, hasBattery: true, shortCircuit: false, openSwitch: true };
    }

    // Separate into series-only or parallel branches
    // For simplicity: if all connected components are in a single path (each node has degree 1 or 2),
    // it's a series circuit. Otherwise try parallel computation.

    // Get non-battery, non-wire resistors
    const resistors = connected.filter(c => c.type === 'resistor' || c.type === 'bulb');
    const wireResistors = connected.filter(c => c.type === 'wire');

    if (resistors.length === 0) {
        // Just wires = short circuit
        if (wireResistors.length > 0) {
            return { req: 0, current: Infinity, power: Infinity, hasBattery: true, shortCircuit: true };
        }
        return { req: 0, current: 0, power: 0, hasBattery: true, shortCircuit: false, openCircuit: true };
    }

    // Determine topology: count degrees for non-wire components
    const nonWire = connected.filter(c => c.type !== 'wire');
    // Check if it's a pure series: each non-wire has degree exactly 2 (or 1 for endpoints)
    let isSeries = true;
    let endpointCount = 0;
    for (const c of nonWire) {
        const deg = (adj.get(c.id) || []).filter(nid => {
            const nc = components.find(cc => cc.id === nid);
            return nc && nc.type !== 'wire' && visited.has(nid);
        }).length;
        if (deg > 2) isSeries = false;
        if (deg <= 1) endpointCount++;
    }

    let req;
    if (isSeries && resistors.length <= 2) {
        // Simple series
        req = resistors.reduce((sum, r) => sum + r.resistance, 0) + wireResistors.reduce((s, w) => s + w.resistance, 0);
    } else {
        // Try to identify parallel: all resistors connected between the same two nodes (battery terminals)
        // A simpler heuristic: if there's a battery and multiple resistors, assume parallel if not series
        if (resistors.length >= 2 && !isSeries) {
            // Parallel: 1/Req = sum(1/Ri)
            let invSum = 0;
            for (const r of resistors) {
                if (r.resistance > 0) invSum += 1 / r.resistance;
            }
            req = invSum > 0 ? 1 / invSum : 0;
            // Add wire resistance in series with the parallel block
            req += wireResistors.reduce((s, w) => s + w.resistance, 0);
        } else if (resistors.length === 1) {
            req = resistors[0].resistance + wireResistors.reduce((s, w) => s + w.resistance, 0);
        } else {
            // Mixed / unknown - treat as series
            req = resistors.reduce((sum, r) => sum + r.resistance, 0) + wireResistors.reduce((s, w) => s + w.resistance, 0);
        }
    }

    const current = req > 0 ? batteryVoltage / req : 0;
    const power = batteryVoltage * current;

    // Branch currents for parallel
    let branchCurrents = [];
    if (!isSeries && resistors.length >= 2) {
        for (const r of resistors) {
            branchCurrents.push({ id: r.id, current: r.resistance > 0 ? batteryVoltage / r.resistance : 0 });
        }
    }

    return { req, current, power, hasBattery: true, shortCircuit: false, branchCurrents, batteryVoltage };
}

// ═══ Drawing ═══
function drawComponent(comp, isHovered, isSelected) {
    const cx = comp.gx, cy = comp.gy;
    const r = 8;

    // Highlight
    if (isHovered || isSelected) {
        ctx.fillStyle = T.accentSoft;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = T.accent;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    switch (comp.type) {
        case 'battery':
            // Long line (positive) and short line (negative)
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 3;
            // Long line
            ctx.beginPath();
            ctx.moveTo(cx - 7, cy - 5);
            ctx.lineTo(cx + 7, cy - 5);
            ctx.stroke();
            // Short line
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(cx - 3, cy + 5);
            ctx.lineTo(cx + 3, cy + 5);
            ctx.stroke();
            // Plus/minus
            ctx.fillStyle = T.ink;
            ctx.font = T.font(8, 'bold');
            ctx.textAlign = 'center';
            ctx.fillText('+', cx + 11, cy - 3);
            ctx.fillText('−', cx + 11, cy + 8);
            // Connection points
            ctx.fillStyle = T.muted;
            ctx.beginPath(); ctx.arc(cx, cy - 8, 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx, cy + 8, 2.5, 0, Math.PI * 2); ctx.fill();
            break;

        case 'resistor':
            // Zigzag
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            const segW = 3, segH = 3;
            ctx.moveTo(cx, cy - 9);
            for (let i = 0; i < 5; i++) {
                const sx = cx + (i % 2 === 0 ? -segW : segW);
                const sy = cy - 9 + (i + 1) * (18 / 6);
                ctx.lineTo(sx, sy);
            }
            ctx.lineTo(cx, cy + 9);
            ctx.stroke();
            // Connection points
            ctx.fillStyle = T.muted;
            ctx.beginPath(); ctx.arc(cx, cy - 9, 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx, cy + 9, 2.5, 0, Math.PI * 2); ctx.fill();
            // Label resistance
            ctx.fillStyle = T.text;
            ctx.font = T.font(9, 'bold');
            ctx.textAlign = 'center';
            ctx.fillText(comp.resistance + '\u03A9', cx, cy + 20);
            break;

        case 'bulb':
            // Circle with filament
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, 8, 0, Math.PI * 2);
            ctx.stroke();
            // Filament
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = T.danger;
            ctx.beginPath();
            ctx.moveTo(cx - 3, cy - 3);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx + 3, cy - 3);
            ctx.stroke();
            // Base
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy + 8);
            ctx.lineTo(cx, cy + 11);
            ctx.stroke();
            // Connection points
            ctx.fillStyle = T.muted;
            ctx.beginPath(); ctx.arc(cx, cy - 8, 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx, cy + 11, 2.5, 0, Math.PI * 2); ctx.fill();
            // Glow when circuit is active
            const result = analyzeCircuit();
            if (result.current > 0 && !result.shortCircuit && !result.openCircuit) {
                const brightness = Math.min(1, result.current / 2);
                const glowRgb = SimLib.Color.parse(T.glow);
                ctx.fillStyle = `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, ${0.15 + brightness * 0.5})`;
                ctx.beginPath();
                ctx.arc(cx, cy, 14, 0, Math.PI * 2);
                ctx.fill();
            }
            break;

        case 'wire':
            // Small dot
            ctx.fillStyle = T.ink;
            ctx.beginPath();
            ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
            ctx.fill();
            break;

        case 'switch':
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 2.5;
            if (comp.switchClosed) {
                ctx.beginPath();
                ctx.moveTo(cx, cy - 8);
                ctx.lineTo(cx - 4, cy);
                ctx.lineTo(cx + 5, cy + 5);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.moveTo(cx, cy - 8);
                ctx.lineTo(cx - 4, cy);
                ctx.moveTo(cx + 6, cy);
                ctx.lineTo(cx + 10, cy + 4);
                ctx.stroke();
                // "Open" indicator
                ctx.strokeStyle = T.danger;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(cx + 6, cy);
                ctx.lineTo(cx + 10, cy + 4);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // Connection points
            ctx.fillStyle = T.muted;
            ctx.beginPath(); ctx.arc(cx, cy - 8, 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(cx, cy + 8, 2.5, 0, Math.PI * 2); ctx.fill();
            break;
    }

    if (isSelected) {
        ctx.strokeStyle = T.accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
        ctx.stroke();
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);

    // Background + grid + title (shared theme)
    SimLib.Draw.background(ctx, W, H, T);
    SimLib.Draw.grid(ctx, W, H, { step: GRID, color: 'rgba(26, 42, 78, 0.05)', lineWidth: 1, theme: T });
    SimLib.Draw.title(ctx, 'Circuit Builder', 12, 18, { size: 13, color: T.muted, theme: T });
    SimLib.Draw.legend(ctx, [
        { color: T.accent, label: 'Live', shape: 'line' },
        { color: T.faint, label: 'Open', shape: 'line' },
    ], W - 132, 14, { size: 10, gap: 12, theme: T });

    // Draw wires
    const result = analyzeCircuit();
    const hasCurrent = result.current > 0 && !result.shortCircuit && !result.openSwitch && !result.openCircuit;

    for (const w of wires) {
        if (w.compA && w.compB) {
            ctx.strokeStyle = hasCurrent ? T.accent : T.faint;
            ctx.lineWidth = hasCurrent ? 3 : 2;
            ctx.beginPath();
            ctx.moveTo(w.compA.gx, w.compA.gy);
            ctx.lineTo(w.compB.gx, w.compB.gy);
            ctx.stroke();
            // Current direction arrows (animated via opacity)
            if (hasCurrent) {
                const mx = (w.compA.gx + w.compB.gx) / 2;
                const my = (w.compA.gy + w.compB.gy) / 2;
                const dx = w.compB.gx - w.compA.gx;
                const dy = w.compB.gy - w.compA.gy;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist > 20) {
                    const nx = dx / dist, ny = dy / dist;
                    const arrowCount = Math.floor(dist / 30);
                    for (let i = 0; i < arrowCount; i++) {
                        const t = (i + 0.5) / arrowCount;
                        const ax = w.compA.gx + dx * t;
                        const ay = w.compA.gy + dy * t;
                        const alpha = 0.3 + 0.4 * Math.abs(Math.sin(Date.now() * 0.003 + i));
                        const accRgb = SimLib.Color.parse(T.accent);
                        ctx.fillStyle = `rgba(${accRgb.r}, ${accRgb.g}, ${accRgb.b}, ${alpha.toFixed(2)})`;
                        ctx.beginPath();
                        ctx.moveTo(ax + nx * 4, ay + ny * 4);
                        ctx.lineTo(ax - nx * 3 + ny * 2.5, ay - ny * 3 - nx * 2.5);
                        ctx.lineTo(ax - nx * 3 - ny * 2.5, ay - ny * 3 + nx * 2.5);
                        ctx.fill();
                    }
                }
            }
        }
    }

    // Draw dragging wire preview
    if (draggingWire) {
        const dragRgb = SimLib.Color.parse(T.accent);
        ctx.strokeStyle = `rgba(${dragRgb.r}, ${dragRgb.g}, ${dragRgb.b}, 0.4)`;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(draggingWire.sx, draggingWire.sy);
        ctx.lineTo(draggingWire.ex, draggingWire.ey);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Draw components
    const sel = selectedComp;
    for (const comp of components) {
        drawComponent(comp, comp === hoveredComp && comp !== sel, comp === sel);
    }

    // Short circuit warning
    if (result.shortCircuit) {
        ctx.fillStyle = 'rgba(220, 38, 38, 0.12)';
        ctx.fillRect(0, 0, W, H);
        SimLib.Draw.text(ctx, '⚠ SHORT CIRCUIT — Check your wiring', W/2, H - 20, { size: 16, weight: 'bold', color: T.danger, align: 'center', theme: T });
    }

    if (result.openSwitch) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
        ctx.fillRect(0, 0, W, H);
        SimLib.Draw.text(ctx, 'Switch is open — close it to complete the circuit', W/2, H - 20, { size: 14, weight: 'bold', color: T.warn, align: 'center', theme: T });
    }

    if (result.openCircuit) {
        ctx.fillStyle = 'rgba(100, 100, 100, 0.06)';
        ctx.fillRect(0, 0, W, H);
        SimLib.Draw.text(ctx, 'Open circuit — connect components with wires to form a loop', W/2, H - 20, { size: 13, color: T.muted, align: 'center', theme: T });
    }
}

// ═══ Update UI ═══
function updateReadouts() {
    const r = analyzeCircuit();
    document.getElementById('vBat').textContent = batteryVoltage.toFixed(1);
    if (r.shortCircuit) {
        document.getElementById('current').textContent = '∞';
        document.getElementById('req').textContent = '0';
        document.getElementById('power').textContent = '∞';
        document.getElementById('current').parentElement.classList.add('sim-readout--warn');
    } else if (r.openSwitch || r.openCircuit) {
        document.getElementById('current').textContent = '0.00';
        document.getElementById('req').textContent = r.openCircuit ? '∞' : '∞';
        document.getElementById('power').textContent = '0.00';
        document.getElementById('current').parentElement.classList.remove('sim-readout--warn');
    } else {
        document.getElementById('current').textContent = r.current.toFixed(3);
        document.getElementById('req').textContent = r.req.toFixed(1);
        document.getElementById('power').textContent = r.power.toFixed(2);
        document.getElementById('current').parentElement.classList.remove('sim-readout--warn');
    }
}

// ═══ Event Handling ═══
const toolButtons = document.querySelectorAll('.sim-tool');
toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        toolButtons.forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        selectedTool = btn.dataset.value;
        selectedComp = null;
    });
});

canvas.addEventListener('pointerdown', (e) => {
    const pos = getCanvasPos(e);
    const snap = snapToGrid(pos.x, pos.y);

    if (selectedTool === 'delete') {
        const removed = deleteCompAt(snap.x, snap.y);
        if (!removed) {
            // Try to delete wires near this position
        }
        selectedComp = null;
        draw();
        updateReadouts();
        return;
    }

    if (selectedTool === 'wire') {
        // Start wire drag
        const comp = findCompAt(snap.x, snap.y);
        if (comp) {
            draggingWire = { from: comp, sx: comp.gx, sy: comp.gy, ex: pos.x, ey: pos.y };
            canvas.setPointerCapture(e.pointerId);
        }
        return;
    }

    // Check if clicking on existing component
    const existing = findCompAt(snap.x, snap.y);
    if (existing) {
        if (existing.type === 'switch') {
            existing.switchClosed = !existing.switchClosed;
            draw();
            updateReadouts();
            return;
        }
        if (existing.type === 'battery') {
            // Allow voltage adjustment via prompt
            const newV = prompt('Set battery voltage (V):', batteryVoltage);
            if (newV !== null && !isNaN(+newV) && +newV > 0 && +newV <= 120) {
                batteryVoltage = +newV;
                updateReadouts();
                draw();
            }
            return;
        }
        if (existing.type === 'resistor') {
            const newR = prompt('Set resistance (Ω):', existing.resistance);
            if (newR !== null && !isNaN(+newR) && +newR >= 0.1 && +newR <= 100000) {
                existing.resistance = +newR;
                updateReadouts();
                draw();
            }
            return;
        }
        // Select for dragging
        selectedComp = existing;
        isDragging = true;
        dragOffsetX = existing.gx - snap.x;
        dragOffsetY = existing.gy - snap.y;
        canvas.style.cursor = 'grabbing';
        canvas.setPointerCapture(e.pointerId);
        return;
    }

    // Place new component
    if (['battery', 'resistor', 'bulb', 'wire', 'switch'].includes(selectedTool)) {
        const comp = addComponent(selectedTool, snap.x, snap.y);
        if (comp && selectedTool === 'battery') {
            // Default
        }
        if (comp && selectedTool === 'resistor') {
            comp.resistance = 100;
        }
    }

    selectedComp = null;
    draw();
    updateReadouts();
});

canvas.addEventListener('pointermove', (e) => {
    const pos = getCanvasPos(e);

    if (draggingWire) {
        draggingWire.ex = pos.x;
        draggingWire.ey = pos.y;
        draw();
        return;
    }

    if (isDragging && selectedComp) {
        const snap = snapToGrid(pos.x + dragOffsetX, pos.y + dragOffsetY);
        // Don't move onto another component
        const other = findCompAt(snap.x, snap.y);
        if (!other || other.id === selectedComp.id) {
            selectedComp.gx = snap.x;
            selectedComp.gy = snap.y;
            // Update wire positions automatically
            draw();
        }
        return;
    }

    const snap = snapToGrid(pos.x, pos.y);
    hoveredComp = findCompAt(snap.x, snap.y);
    if (hoveredComp || draggingWire) {
        canvas.style.cursor = 'pointer';
    } else if (['battery', 'resistor', 'bulb', 'wire', 'switch'].includes(selectedTool)) {
        canvas.style.cursor = 'crosshair';
    } else {
        canvas.style.cursor = 'default';
    }
    draw();
});

canvas.addEventListener('pointerup', (e) => {
    if (draggingWire) {
        const pos = getCanvasPos(e);
        const snap = snapToGrid(pos.x, pos.y);
        const target = findCompAt(snap.x, snap.y);
        if (target && target.id !== draggingWire.from.id) {
            // Add wire if not already present
            const already = wires.find(w =>
                (w.compA.id === draggingWire.from.id && w.compB.id === target.id) ||
                (w.compA.id === target.id && w.compB.id === draggingWire.from.id)
            );
            if (!already) {
                wires.push({ compA: draggingWire.from, compB: target });
            }
        }
        draggingWire = null;
        draw();
        updateReadouts();
    }
    isDragging = false;
    canvas.style.cursor = 'default';
});
canvas.addEventListener('pointercancel', () => {
    draggingWire = null;
    isDragging = false;
    canvas.style.cursor = 'default';
});

// ═══ Presets ═══
function clearAll() {
    components = [];
    wires = [];
    selectedComp = null;
    batteryVoltage = 9.0;
    draw();
    updateReadouts();
}

document.getElementById('presetSeries').addEventListener('click', () => {
    clearAll();
    const cx = 12, cyBase = 12;
    const bat = addComponent('battery', cx * GRID, cyBase * GRID);
    const r1 = addComponent('resistor', cx * GRID, (cyBase + 5) * GRID);
    r1.resistance = 100;
    const r2 = addComponent('resistor', cx * GRID, (cyBase + 10) * GRID);
    r2.resistance = 220;
    wires.push({ compA: bat, compB: r1 });
    wires.push({ compA: r1, compB: r2 });
    // Close the loop: r2 back to battery
    wires.push({ compA: r2, compB: bat });
    batteryVoltage = 9.0;
    draw();
    updateReadouts();
});

document.getElementById('presetParallel').addEventListener('click', () => {
    clearAll();
    const cx = 12;
    // Battery on left
    const bat = addComponent('battery', cx * GRID, 12 * GRID);
    // Two resistors side by side
    const r1 = addComponent('resistor', (cx + 6) * GRID, 7 * GRID);
    r1.resistance = 100;
    const r2 = addComponent('resistor', (cx + 6) * GRID, 17 * GRID);
    r2.resistance = 220;
    // Junction nodes (wire components)
    const jTop = addComponent('wire', (cx + 3) * GRID, 7 * GRID);
    const jBot = addComponent('wire', (cx + 3) * GRID, 17 * GRID);
    const jTopR = addComponent('wire', (cx + 9) * GRID, 7 * GRID);
    const jBotR = addComponent('wire', (cx + 9) * GRID, 17 * GRID);

    // Wiring
    wires.push({ compA: bat, compB: jTop });
    wires.push({ compA: jTop, compB: r1 });
    wires.push({ compA: r1, compB: jTopR });
    wires.push({ compA: jTopR, compB: jBotR });
    wires.push({ compA: jBotR, compB: r2 });
    wires.push({ compA: r2, compB: jBot });
    wires.push({ compA: jBot, compB: bat });

    batteryVoltage = 9.0;
    draw();
    updateReadouts();
});

document.getElementById('clearBtn').addEventListener('click', clearAll);
document.getElementById('runBtn').addEventListener('click', () => {
    updateReadouts();
    draw();
});

// ═══ Animation (SimLib) ═══
// The circuit is drawn in a fixed 800x520 logical coordinate space; SimLib
// maps that space onto the responsive (HiDPI-aware) displayed canvas so that
// what is drawn and what the pointer hits both line up.

// Initialize preset state
document.getElementById('presetSeries').click();
updateReadouts();

const app = SimLib.attach({
    canvas: canvas,
    logicalWidth: 800,
    logicalHeight: 520,
    SimulationClass: class CircuitSim extends SimLib.Simulation {
        onResize() { draw(); }
        onTick() { updateReadouts(); }
        onDraw(ctx) { draw(); }
    }
});
app.sim.start();
    return { app };
}
