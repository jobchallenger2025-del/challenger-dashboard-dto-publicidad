let tasks = [];
let currentGanttMonth = new Date(); currentGanttMonth.setDate(1); currentGanttMonth.setHours(0, 0, 0, 0);
let currentCalendarDate = new Date(); currentCalendarDate.setDate(1); currentCalendarDate.setHours(0,0,0,0);
let ganttViewMode = 'monthly';
let loadedTaskImageBase64 = null;
let cachedAvatars = {}; // Cache local de avatares sincronizado con Firestore
let _firstTaskLoad = true; // Para detectar la primera carga

// ==================== REFERENCIAS FIRESTORE ====================
const tasksCollection = db.collection('tasks');
const avatarsDoc = db.collection('avatars').doc('custom');

document.addEventListener('DOMContentLoaded', () => {
    setupNavTabs(); setupModal(); setupFilters(); setupGanttNav();
    setupCompletedToggle(); setupImageUpload(); setupLightbox(); setupActivityPreviewModal(); setupTakeTaskModal();
    setupDataButtons(); setupNavDateTime(); setupMetricsNav();

    // 🔴 SUSCRIPCIÓN EN TIEMPO REAL — Tareas
    subscribeToTasks();
    // 🔴 SUSCRIPCIÓN EN TIEMPO REAL — Avatares
    subscribeToAvatars();

    showStorageStatus();
});

// ==================== FIRESTORE: TIEMPO REAL ====================
function subscribeToTasks() {
    tasksCollection.orderBy('updatedAt', 'desc').onSnapshot((snapshot) => {
        const newTasks = snapshot.docs.map(doc => ({ ...doc.data(), _firestoreId: doc.id }));
        console.log(`🔥 Firestore onSnapshot: ${newTasks.length} tareas recibidas`);
        
        // Log detallado de cada tarea recibida
        newTasks.forEach(t => {
            console.log(`📥 Tarea recibida: "${t.name}"`, {
                status: t.status,
                statusManualOverride: t.statusManualOverride,
                updatedAt: t.updatedAt
            });
        });

        // Si la colección está vacía en la primera carga, NO sembrar datos de prueba para evitar pérdida de datos
        if (newTasks.length === 0 && _firstTaskLoad) {
            _firstTaskLoad = false;
            console.warn('Colección vacía, NO sembrando datos de prueba para evitar pérdida de datos.');
            // seedMockTasks(); // Comentado para evitar la pérdida de datos
            return;
        }
        _firstTaskLoad = false;

        // Preservar statusManualOverride local para tareas que fueron editadas recientemente
        const localOverrides = new Map();
        tasks.forEach(t => {
            if (t.statusManualOverride) {
                localOverrides.set(t.id, t.statusManualOverride);
            }
        });

        tasks = newTasks;

        // Restaurar statusManualOverride si existe en el mapa local
        tasks.forEach(t => {
            if (localOverrides.has(t.id)) {
                console.log(`🔄 Restaurando statusManualOverride para "${t.name}"`);
                t.statusManualOverride = localOverrides.get(t.id);
            }
        });

        renderAll();
        // Asegurar que los gráficos de métricas se rendericen
        if (document.getElementById('tdClock')) {
            renderMetrics();
        }
        showSavedIndicator();
    }, (error) => {
        console.error('❌ Error en onSnapshot de tareas:', error);
        showToast('Error de conexión con Firestore', 'error');
    });
}

function subscribeToAvatars() {
    avatarsDoc.onSnapshot((doc) => {
        if (doc.exists) {
            cachedAvatars = doc.data() || {};
            console.log('🔥 Avatares sincronizados:', Object.keys(cachedAvatars).length);
            renderAll(); // Re-render para mostrar avatares actualizados
        } else {
            cachedAvatars = {};
        }
    }, (error) => {
        console.error('❌ Error en onSnapshot de avatares:', error);
    });
}

// Estados que nunca deben ser sobrescritos por alertas automáticas de cuello de botella
const AUTO_CRITICAL_EXEMPT_STATUSES = new Set([
    'disponible',
    'completado',
    'ajuste-cambios-revision',
    'en-critico',
]);

function isManualStatusProtected(task) {
    if (task?.statusManualOverride) return true;
    return AUTO_CRITICAL_EXEMPT_STATUSES.has(task?.status);
}

// ==================== FIRESTORE: ESCRITURA ====================
async function saveTaskToFirestore(taskData, options = {}) {
    try {
        const docId = String(taskData.id);
        // Eliminar el campo _firestoreId antes de guardar (es metadata local)
        const { _firestoreId, ...cleanData } = taskData;
        const ref = tasksCollection.doc(docId);

        console.log(`💾 Guardando en Firestore:`, {
            id: docId,
            status: cleanData.status,
            statusManualOverride: cleanData.statusManualOverride,
            updatedAt: cleanData.updatedAt
        });

        if (options.onlyIfNewer && cleanData.updatedAt) {
            const doc = await ref.get();
            if (doc.exists) {
                const existingUpdatedAt = doc.data()?.updatedAt;
                if (existingUpdatedAt && existingUpdatedAt > cleanData.updatedAt) {
                    console.log('⏭️ Escritura omitida (datos más recientes en Firestore):', docId);
                    return false;
                }
            }
        }

        // SIEMPRE usar merge para asegurar que los campos se actualicen correctamente
        await ref.set(cleanData, { merge: true });
        console.log('✅ Tarea guardada en Firestore con merge:', docId);
        return true;
    } catch (error) {
        console.error('❌ Error guardando tarea en Firestore:', error);
        showToast('Error al guardar en la nube', 'error');
        return false;
    }
}

async function deleteTaskFromFirestore(taskId) {
    try {
        const docId = String(taskId);
        await tasksCollection.doc(docId).delete();
        console.log('🗑️ Tarea eliminada de Firestore:', docId);
    } catch (error) {
        console.error('❌ Error eliminando tarea de Firestore:', error);
        showToast('Error al eliminar de la nube', 'error');
    }
}

async function batchImportTasks(tasksArray) {
    try {
        const batch = db.batch();
        tasksArray.forEach(task => {
            const docId = String(task.id);
            const { _firestoreId, ...cleanData } = task;
            batch.set(tasksCollection.doc(docId), cleanData);
        });
        await batch.commit();
        console.log(`✅ ${tasksArray.length} tareas importadas en batch a Firestore`);
    } catch (error) {
        console.error('❌ Error en batch import:', error);
        showToast('Error al importar a Firestore', 'error');
    }
}

async function saveAvatarToFirestore(name, base64) {
    try {
        await avatarsDoc.set({ [name]: base64 }, { merge: true });
        console.log('✅ Avatar guardado en Firestore:', name);
    } catch (error) {
        console.error('❌ Error guardando avatar en Firestore:', error);
        showToast('Error al guardar avatar', 'error');
    }
}

async function deleteAllTasksFromFirestore() {
    try {
        const snapshot = await tasksCollection.get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log('🗑️ Todas las tareas eliminadas de Firestore');
    } catch (error) {
        console.error('❌ Error formateando flujo:', error);
        showToast('Error al formatear', 'error');
    }
}

// ==================== SEED: DATOS DE PRUEBA ====================
async function seedMockTasks() {
    const mockTasks = getMockTasks();
    await batchImportTasks(mockTasks);
    showToast('Datos de ejemplo cargados', 'info');
}

function getMockTasks() {
    return [
        {
            id: 1,
            name: 'Diseño de interfaz',
            client: 'Cliente A',
            category: 'diseno',
            status: 'en-proceso',
            start: '2024-06-19T08:00:00.000Z',
            end: '2024-06-20T18:00:00.000Z',
            responsible: 'Juan Pérez',
            pauses: [
                { id: 1, reason: 'Revisión con cliente', observation: 'Cliente solicitó cambios', startDate: '2024-06-19', endDate: '2024-06-19' },
                { id: 2, reason: 'Esperando recursos', observation: 'Falta material gráfico', startDate: '2024-06-19', endDate: '2024-06-19' }
            ],
            updatedAt: new Date().toISOString()
        },
        {
            id: 2,
            name: 'Desarrollo backend',
            client: 'Cliente B',
            category: 'desarrollo',
            status: 'en-proceso',
            start: '2024-06-19T09:00:00.000Z',
            end: '2024-06-21T18:00:00.000Z',
            responsible: 'María García',
            pauses: [],
            updatedAt: new Date().toISOString()
        },
        {
            id: 3,
            name: 'Testing QA',
            client: 'Cliente C',
            category: 'testing',
            status: 'completado',
            start: '2024-06-18T08:00:00.000Z',
            end: '2024-06-19T18:00:00.000Z',
            responsible: 'Pedro López',
            pauses: [],
            updatedAt: new Date().toISOString()
        },
        {
            id: 4,
            name: 'Producción',
            client: 'Cliente D',
            category: 'produccion',
            status: 'en-critico',
            start: '2024-06-19T10:00:00.000Z',
            end: '2024-06-20T18:00:00.000Z',
            responsible: 'Ana Martínez',
            pauses: [
                { id: 3, reason: 'Error en servidor', observation: 'Servidor caído', startDate: '2024-06-19', endDate: '2024-06-19' }
            ],
            updatedAt: new Date().toISOString()
        },
        {
            id: 5,
            name: 'Marketing',
            client: 'Cliente E',
            category: 'marketing',
            status: 'en-proceso',
            start: '2024-06-19T11:00:00.000Z',
            end: '2024-06-22T18:00:00.000Z',
            responsible: 'Carlos Rodríguez',
            pauses: [],
            updatedAt: new Date().toISOString()
        }
    ];
}

function showStorageStatus() {
    const el = document.getElementById('storageSizeLabel');
    if (el) {
        el.textContent = '🔥 Firestore';
        el.title = 'Conectado a Firebase Firestore en tiempo real';
        el.style.color = '#10b981';
        el.style.display = 'inline';
    }
}

function setupNavTabs() {
    const toggleBtn = document.getElementById('menuToggleBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('sidebar-open');
        });
    }

    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('view' + capitalize(tab.dataset.view)).classList.add('active');
            if (tab.dataset.view === 'marketplace') renderMarketplace();
            if (tab.dataset.view === 'calendar') renderCalendar();
            
            // Control de banner según sección activa
            if (tab.dataset.view === 'report') {
                document.body.classList.add('metrics-challenger-active');
            } else {
                document.body.classList.remove('metrics-challenger-active');
            }
            
            // Auto-cerrar el menú en móviles (opcional, pero útil)
            if (window.innerWidth <= 1024) {
                document.body.classList.remove('sidebar-open');
            }
        });
    });
}

let navClockRaf = null;

function setupNavDateTime() {
    buildNavClockTicks();
    if (navClockRaf) cancelAnimationFrame(navClockRaf);
    const tick = () => {
        updateNavDateTime();
        navClockRaf = requestAnimationFrame(tick);
    };
    tick();
}

function buildNavClockTicks() {
    const ticksG = document.getElementById('navClockTicks');
    if (!ticksG || ticksG.childElementCount) return;
    const cx = 50, cy = 50;
    for (let i = 0; i < 60; i++) {
        const isMajor = i % 5 === 0;
        const angle = (i * 6 - 90) * Math.PI / 180;
        const inner = isMajor ? 38 : 41;
        const outer = 44;
        const x1 = cx + inner * Math.cos(angle);
        const y1 = cy + inner * Math.sin(angle);
        const x2 = cx + outer * Math.cos(angle);
        const y2 = cy + outer * Math.sin(angle);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1.toFixed(2));
        line.setAttribute('y1', y1.toFixed(2));
        line.setAttribute('x2', x2.toFixed(2));
        line.setAttribute('y2', y2.toFixed(2));
        line.setAttribute('class', isMajor ? 'nav-clock-tick nav-clock-tick-major' : 'nav-clock-tick');
        ticksG.appendChild(line);
    }
}

function updateNavDateTime() {
    const now = new Date();
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const dateEl = document.getElementById('navDateLabel');
    const timeEl = document.getElementById('navTimeLabel');
    if (dateEl) {
        dateEl.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
    }
    if (timeEl) {
        timeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    }

    const h = now.getHours() % 12;
    const m = now.getMinutes();
    const s = now.getSeconds();
    const ms = now.getMilliseconds();
    const secondDeg = (s + ms / 1000) * 6;
    const minuteDeg = (m + s / 60 + ms / 60000) * 6;
    const hourDeg = (h + m / 60 + s / 3600) * 30;

    const hourHand = document.getElementById('navClockHourHand');
    const minuteHand = document.getElementById('navClockMinuteHand');
    const secondHand = document.getElementById('navClockSecondHand');
    if (hourHand) hourHand.setAttribute('transform', `rotate(${hourDeg} 50 50)`);
    if (minuteHand) minuteHand.setAttribute('transform', `rotate(${minuteDeg} 50 50)`);
    if (secondHand) secondHand.setAttribute('transform', `rotate(${secondDeg} 50 50)`);
}

function setupModal() {
    document.getElementById('btnCloseModal').addEventListener('click', closeModal);
    document.getElementById('btnCancelModal').addEventListener('click', closeModal);
    document.getElementById('taskModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    document.getElementById('taskForm').addEventListener('submit', handleSaveTask);
    setupCustomResponsibleSelect();
    setupPhotoShootRef();
}

function setupPhotoShootRef() {
    const cb = document.getElementById('taskPhotoShoot');
    if (!cb) return;
    cb.addEventListener('change', togglePhotoRefBox);
}

function setBaseTecnicaValue(isYes) {
    const si = document.getElementById('taskBaseTecnicaSi');
    const no = document.getElementById('taskBaseTecnicaNo');
    if (si) si.checked = !!isYes;
    if (no) no.checked = !isYes;
}

function getBaseTecnicaValue() {
    const si = document.getElementById('taskBaseTecnicaSi');
    return si ? si.checked : false;
}

function togglePhotoRefBox() {
    const cb = document.getElementById('taskPhotoShoot');
    const box = document.getElementById('photoRefBox');
    const refInput = document.getElementById('taskPhotoShootRef');
    if (!cb || !box) return;
    box.style.display = cb.checked ? 'block' : 'none';
    if (!cb.checked && refInput) refInput.value = '';
}

// ─── Multi-responsible helpers ───────────────────────────────────────────────
// responsible field stores an array of up to 2 names (JSON string in hidden input)
const MAX_RESPONSIBLES = 2;

function getResponsiblesArray(t) {
    if (!t || !t.responsible) return [];
    if (Array.isArray(t.responsible)) return t.responsible.filter(Boolean);
    try {
        const parsed = JSON.parse(t.responsible);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch(e) {}
    // legacy single string
    return t.responsible.trim() ? [t.responsible.trim()] : [];
}

function responsibleDisplayHtml(t, avatarStyle) {
    const list = getResponsiblesArray(t);
    if (!list.length) return '<span class="avatar-empty">—</span>';
    return list.map(name =>
        `<span style="display:inline-flex;align-items:center;gap:4px;">
            ${getAvatarHtml(name, avatarStyle || '')}
            <span class="resp-name">${esc(name)}</span>
        </span>`
    ).join('<span style="color:var(--text-muted);margin:0 2px;">&</span>');
}

function responsibleFirstName(t) {
    const list = getResponsiblesArray(t);
    return list[0] || '';
}

function isResponsibleAssigned(t) {
    return getResponsiblesArray(t).length > 0;
}

// ─── Custom multi-select UI ───────────────────────────────────────────────────
function updateCustomSelectUI(val) {
    // val can be a JSON array string or a single string (legacy)
    const hiddenInput = document.getElementById('taskResponsible');
    const valueContainer = document.querySelector('#responsibleSelectTrigger .custom-select-value');
    const optionsContainer = document.getElementById('responsibleSelectOptions');
    if(!hiddenInput || !valueContainer || !optionsContainer) return;

    let selectedArr = [];
    if (val && val !== '') {
        try {
            const parsed = JSON.parse(val);
            selectedArr = Array.isArray(parsed) ? parsed.filter(Boolean) : [val];
        } catch(e) {
            selectedArr = val.trim() ? [val.trim()] : [];
        }
    }

    hiddenInput.value = JSON.stringify(selectedArr);

    // Mark options
    optionsContainer.querySelectorAll('.custom-option').forEach(o => {
        const v = o.getAttribute('data-value');
        if (v === '') {
            o.classList.toggle('selected', selectedArr.length === 0);
        } else {
            o.classList.toggle('selected', selectedArr.includes(v));
        }
    });

    // Update trigger display
    refreshResponsibleTrigger(selectedArr, valueContainer);
}

function refreshResponsibleTrigger(selectedArr, valueContainer) {
    if (!valueContainer) valueContainer = document.querySelector('#responsibleSelectTrigger .custom-select-value');
    if (!valueContainer) return;
    if (!selectedArr || selectedArr.length === 0) {
        valueContainer.innerHTML = `<span class="avatar-empty" style="margin-right:8px;">—</span> Sin Asignar...`;
        return;
    }
    valueContainer.innerHTML = selectedArr.map(name =>
        `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:6px;">
            ${getAvatarHtml(name, 'width:24px;height:24px;font-size:0.65rem;')}
            <span style="font-size:0.8rem;">${esc(name)}</span>
        </span>`
    ).join('<span style="color:var(--text-muted);font-size:0.7rem;">+</span>');
}

function setupCustomResponsibleSelect() {
    const wrapper = document.getElementById('responsibleSelectWrapper');
    const trigger = document.getElementById('responsibleSelectTrigger');
    const optionsContainer = document.getElementById('responsibleSelectOptions');
    const hiddenInput = document.getElementById('taskResponsible');
    if(!wrapper || !trigger || !optionsContainer || !hiddenInput) return;
    const valueContainer = trigger.querySelector('.custom-select-value');

    const teamMembers = ['Diego Rozo', 'Maycol Vargas', 'Daniela Duarte', 'Alexander Peña', 'Daniel Angulo', 'Camilo Davila'];

    // Add multi-select hint label
    let optionsHtml = `<div class="responsible-select-hint">Selecciona hasta ${MAX_RESPONSIBLES} responsables</div>`;
    optionsHtml += `<div class="custom-option" data-value="">
        <span class="avatar-empty" style="margin-right: 8px;">—</span> Sin Asignar...
    </div>`;

    teamMembers.forEach(member => {
        optionsHtml += `<div class="custom-option" data-value="${esc(member)}">
            ${getAvatarHtml(member, 'width: 28px; height: 28px; margin-right: 8px;')}
            <span>${esc(member)}</span>
            <span class="resp-check-icon">✓</span>
        </div>`;
    });
    optionsContainer.innerHTML = optionsHtml;

    trigger.addEventListener('click', () => {
        wrapper.classList.toggle('open');
    });

    optionsContainer.addEventListener('click', (e) => {
        const option = e.target.closest('.custom-option');
        if(!option) return;

        const val = option.getAttribute('data-value');
        let currentArr = [];
        try {
            const parsed = JSON.parse(hiddenInput.value);
            currentArr = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        } catch(e) { currentArr = []; }

        if (val === '') {
            // Clear all
            currentArr = [];
        } else {
            if (currentArr.includes(val)) {
                // Deselect
                currentArr = currentArr.filter(v => v !== val);
            } else {
                if (currentArr.length >= MAX_RESPONSIBLES) {
                    showToast(`Máximo ${MAX_RESPONSIBLES} responsables por proyecto`, 'error');
                    return;
                }
                currentArr.push(val);
            }
        }

        hiddenInput.value = JSON.stringify(currentArr);
        refreshResponsibleTrigger(currentArr, valueContainer);

        // Update selected classes
        optionsContainer.querySelectorAll('.custom-option').forEach(o => {
            const v = o.getAttribute('data-value');
            if (v === '') {
                o.classList.toggle('selected', currentArr.length === 0);
            } else {
                o.classList.toggle('selected', currentArr.includes(v));
            }
        });

        // Keep dropdown open for multi-select; close only on 'Sin Asignar'
        if (val === '') wrapper.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
        if(!wrapper.contains(e.target)) {
            wrapper.classList.remove('open');
        }
    });
}

function openAdminTaskModal() {
    const password = prompt('Ingrese la contraseña de administrador:');
    if (password === '9090danielchallenger') {
        openTaskModal();
    } else if (password !== null) {
        showToast('Contraseña incorrecta. Acceso denegado.', 'error');
    }
}

function generateExecutiveReport() {
    try {
        showToast('Generando reporte Excel...', 'info');
        
        // Verificar que la librería XLSX esté cargada
        if (typeof XLSX === 'undefined') {
            showToast('Error: La librería XLSX no está cargada', 'error');
            console.error('XLSX no está definido');
            return;
        }
        
        const now = new Date();
        const dateStr = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const filename = `Reporte_Gestion_Challenger_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;
        
        // Crear libro de trabajo
        const wb = XLSX.utils.book_new();
        
        // Calcular métricas
        const total = tasks.length;
        const inProgress = tasks.filter(t => t.status === 'en-proceso');
        const completed = tasks.filter(t => t.status === 'completado');
        const critical = tasks.filter(t => t.status === 'en-critico');
        const available = tasks.filter(t => t.status !== 'completado' && !isResponsibleAssigned(t));
        
        // Función para formatear fecha
        function formatDate(dateStr) {
            if (!dateStr || dateStr === 'Sin fecha') return 'Sin fecha';
            try {
                const date = new Date(dateStr);
                if (isNaN(date.getTime())) return dateStr;
                return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
            } catch (e) {
                return dateStr;
            }
        }
        
        // PESTAÑA 1: TAREAS TOTALES
        const totalData = [
            ['REPORTE EJECUTIVO - SISTEMA DE GESTIÓN TI CHALLENGER'],
            ['Fecha de generación:', dateStr],
            [],
            ['MÉTRICA', 'VALOR'],
            ['Total de Tareas', total],
            ['Porcentaje Completado', total > 0 ? Math.round((completed.length / total) * 100) + '%' : '0%'],
            ['Tareas Completadas', completed.length],
            ['Tareas en Proceso', inProgress.length],
            ['Tareas Críticas', critical.length],
            ['Tareas Disponibles', available.length],
            [],
            ['DETALLE DE TAREAS'],
            ['Nombre', 'Estado', 'Responsable', 'Cliente', 'Categoría', 'Prioridad', 'Fecha Entrega']
        ];
        
        tasks.forEach(t => {
            const respNames = getResponsiblesArray(t).join(' & ') || 'Sin asignar';
            totalData.push([
                t.name || 'Sin nombre',
                t.status || 'Sin estado',
                respNames,
                t.client || 'Sin cliente',
                t.category || 'Sin categoría',
                t.priority || 'Sin prioridad',
                formatDate(t.deadline)
            ]);
        });
        
        const totalWs = XLSX.utils.aoa_to_sheet(totalData);
        
        // Aplicar formato de negrita a encabezados y ancho de columnas
        totalWs['!cols'] = [
            { wch: 35 }, // Nombre
            { wch: 18 }, // Estado
            { wch: 22 }, // Responsable
            { wch: 22 }, // Cliente
            { wch: 22 }, // Categoría
            { wch: 15 }, // Prioridad
            { wch: 18 }  // Fecha
        ];
        
        // Aplicar estilo a celdas de encabezados
        const totalRange = XLSX.utils.decode_range(totalWs['!ref']);
        for (let C = totalRange.s.c; C <= totalRange.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({ r: 0, c: C });
            if (totalWs[cellAddress]) {
                totalWs[cellAddress].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "0066CC" } },
                    alignment: { horizontal: "center" }
                };
            }
            const cellAddress2 = XLSX.utils.encode_cell({ r: 1, c: C });
            if (totalWs[cellAddress2]) {
                totalWs[cellAddress2].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "E8F4FD" } }
                };
            }
            const cellAddress3 = XLSX.utils.encode_cell({ r: 3, c: C });
            if (totalWs[cellAddress3]) {
                totalWs[cellAddress3].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "FFE6CC" } }
                };
            }
            const cellAddress4 = XLSX.utils.encode_cell({ r: 10, c: C });
            if (totalWs[cellAddress4]) {
                totalWs[cellAddress4].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "D9E2F3" } }
                };
            }
        }
        
        XLSX.utils.book_append_sheet(wb, totalWs, 'Tareas Totales');
        
        // PESTAÑA 2: EN PROCESO
        const inProgressData = [
            ['REPORTE EJECUTIVO - TAREAS EN PROCESO'],
            ['Fecha de generación:', dateStr],
            [],
            ['MÉTRICA', 'VALOR'],
            ['Tareas en Proceso', inProgress.length],
            [],
            ['DETALLE DE TAREAS EN PROCESO'],
            ['Nombre', 'Responsable', 'Cliente', 'Categoría', 'Prioridad', 'Fecha Entrega']
        ];
        
        inProgress.forEach(t => {
            const respNames = getResponsiblesArray(t).join(' & ') || 'Sin asignar';
            inProgressData.push([
                t.name || 'Sin nombre',
                respNames,
                t.client || 'Sin cliente',
                t.category || 'Sin categoría',
                t.priority || 'Sin prioridad',
                formatDate(t.deadline)
            ]);
        });
        
        const inProgressWs = XLSX.utils.aoa_to_sheet(inProgressData);
        inProgressWs['!cols'] = [
            { wch: 35 }, // Nombre
            { wch: 22 }, // Responsable
            { wch: 22 }, // Cliente
            { wch: 22 }, // Categoría
            { wch: 15 }, // Prioridad
            { wch: 18 }  // Fecha
        ];
        
        // Aplicar estilo a encabezados
        const inProgressRange = XLSX.utils.decode_range(inProgressWs['!ref']);
        for (let C = inProgressRange.s.c; C <= inProgressRange.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({ r: 0, c: C });
            if (inProgressWs[cellAddress]) {
                inProgressWs[cellAddress].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "0066CC" } },
                    alignment: { horizontal: "center" }
                };
            }
            const cellAddress2 = XLSX.utils.encode_cell({ r: 1, c: C });
            if (inProgressWs[cellAddress2]) {
                inProgressWs[cellAddress2].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "E8F4FD" } }
                };
            }
            const cellAddress3 = XLSX.utils.encode_cell({ r: 3, c: C });
            if (inProgressWs[cellAddress3]) {
                inProgressWs[cellAddress3].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "FFE6CC" } }
                };
            }
            const cellAddress4 = XLSX.utils.encode_cell({ r: 6, c: C });
            if (inProgressWs[cellAddress4]) {
                inProgressWs[cellAddress4].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "D9E2F3" } }
                };
            }
        }
        
        XLSX.utils.book_append_sheet(wb, inProgressWs, 'En Proceso');
        
        // PESTAÑA 3: COMPLETADAS
        const completedData = [
            ['REPORTE EJECUTIVO - TAREAS COMPLETADAS'],
            ['Fecha de generación:', dateStr],
            [],
            ['MÉTRICA', 'VALOR'],
            ['Tareas Completadas', completed.length],
            [],
            ['DETALLE DE TAREAS COMPLETADAS'],
            ['Nombre', 'Responsable', 'Cliente', 'Categoría', 'Prioridad', 'Fecha Entrega']
        ];
        
        completed.forEach(t => {
            const respNames = getResponsiblesArray(t).join(' & ') || 'Sin asignar';
            completedData.push([
                t.name || 'Sin nombre',
                respNames,
                t.client || 'Sin cliente',
                t.category || 'Sin categoría',
                t.priority || 'Sin prioridad',
                formatDate(t.deadline)
            ]);
        });
        
        const completedWs = XLSX.utils.aoa_to_sheet(completedData);
        completedWs['!cols'] = [
            { wch: 35 }, // Nombre
            { wch: 22 }, // Responsable
            { wch: 22 }, // Cliente
            { wch: 22 }, // Categoría
            { wch: 15 }, // Prioridad
            { wch: 18 }  // Fecha
        ];
        
        // Aplicar estilo a encabezados
        const completedRange = XLSX.utils.decode_range(completedWs['!ref']);
        for (let C = completedRange.s.c; C <= completedRange.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({ r: 0, c: C });
            if (completedWs[cellAddress]) {
                completedWs[cellAddress].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "0066CC" } },
                    alignment: { horizontal: "center" }
                };
            }
            const cellAddress2 = XLSX.utils.encode_cell({ r: 1, c: C });
            if (completedWs[cellAddress2]) {
                completedWs[cellAddress2].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "E8F4FD" } }
                };
            }
            const cellAddress3 = XLSX.utils.encode_cell({ r: 3, c: C });
            if (completedWs[cellAddress3]) {
                completedWs[cellAddress3].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "FFE6CC" } }
                };
            }
            const cellAddress4 = XLSX.utils.encode_cell({ r: 6, c: C });
            if (completedWs[cellAddress4]) {
                completedWs[cellAddress4].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "D9E2F3" } }
                };
            }
        }
        
        XLSX.utils.book_append_sheet(wb, completedWs, 'Completadas');
        
        // PESTAÑA 4: CRÍTICAS
        const criticalData = [
            ['REPORTE EJECUTIVO - TAREAS CRÍTICAS'],
            ['Fecha de generación:', dateStr],
            [],
            ['MÉTRICA', 'VALOR'],
            ['Tareas Críticas', critical.length],
            [],
            ['DETALLE DE TAREAS CRÍTICAS'],
            ['Nombre', 'Responsable', 'Cliente', 'Categoría', 'Prioridad', 'Fecha Entrega']
        ];
        
        critical.forEach(t => {
            const respNames = getResponsiblesArray(t).join(' & ') || 'Sin asignar';
            criticalData.push([
                t.name || 'Sin nombre',
                respNames,
                t.client || 'Sin cliente',
                t.category || 'Sin categoría',
                t.priority || 'Sin prioridad',
                formatDate(t.deadline)
            ]);
        });
        
        const criticalWs = XLSX.utils.aoa_to_sheet(criticalData);
        criticalWs['!cols'] = [
            { wch: 35 }, // Nombre
            { wch: 22 }, // Responsable
            { wch: 22 }, // Cliente
            { wch: 22 }, // Categoría
            { wch: 15 }, // Prioridad
            { wch: 18 }  // Fecha
        ];
        
        // Aplicar estilo a encabezados
        const criticalRange = XLSX.utils.decode_range(criticalWs['!ref']);
        for (let C = criticalRange.s.c; C <= criticalRange.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({ r: 0, c: C });
            if (criticalWs[cellAddress]) {
                criticalWs[cellAddress].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "0066CC" } },
                    alignment: { horizontal: "center" }
                };
            }
            const cellAddress2 = XLSX.utils.encode_cell({ r: 1, c: C });
            if (criticalWs[cellAddress2]) {
                criticalWs[cellAddress2].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "E8F4FD" } }
                };
            }
            const cellAddress3 = XLSX.utils.encode_cell({ r: 3, c: C });
            if (criticalWs[cellAddress3]) {
                criticalWs[cellAddress3].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "FFE6CC" } }
                };
            }
            const cellAddress4 = XLSX.utils.encode_cell({ r: 6, c: C });
            if (criticalWs[cellAddress4]) {
                criticalWs[cellAddress4].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "D9E2F3" } }
                };
            }
        }
        
        XLSX.utils.book_append_sheet(wb, criticalWs, 'Críticas');
        
        // PESTAÑA 5: POR TOMAR
        const availableData = [
            ['REPORTE EJECUTIVO - TAREAS DISPONIBLES'],
            ['Fecha de generación:', dateStr],
            [],
            ['MÉTRICA', 'VALOR'],
            ['Tareas Disponibles', available.length],
            [],
            ['DETALLE DE TAREAS DISPONIBLES'],
            ['Nombre', 'Cliente', 'Categoría', 'Prioridad', 'Fecha Entrega']
        ];
        
        available.forEach(t => {
            availableData.push([
                t.name || 'Sin nombre',
                t.client || 'Sin cliente',
                t.category || 'Sin categoría',
                t.priority || 'Sin prioridad',
                formatDate(t.deadline)
            ]);
        });
        
        const availableWs = XLSX.utils.aoa_to_sheet(availableData);
        availableWs['!cols'] = [
            { wch: 35 }, // Nombre
            { wch: 22 }, // Cliente
            { wch: 22 }, // Categoría
            { wch: 15 }, // Prioridad
            { wch: 18 }  // Fecha
        ];
        
        // Aplicar estilo a encabezados
        const availableRange = XLSX.utils.decode_range(availableWs['!ref']);
        for (let C = availableRange.s.c; C <= availableRange.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({ r: 0, c: C });
            if (availableWs[cellAddress]) {
                availableWs[cellAddress].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "0066CC" } },
                    alignment: { horizontal: "center" }
                };
            }
            const cellAddress2 = XLSX.utils.encode_cell({ r: 1, c: C });
            if (availableWs[cellAddress2]) {
                availableWs[cellAddress2].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "E8F4FD" } }
                };
            }
            const cellAddress3 = XLSX.utils.encode_cell({ r: 3, c: C });
            if (availableWs[cellAddress3]) {
                availableWs[cellAddress3].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "FFE6CC" } }
                };
            }
            const cellAddress4 = XLSX.utils.encode_cell({ r: 6, c: C });
            if (availableWs[cellAddress4]) {
                availableWs[cellAddress4].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: "D9E2F3" } }
                };
            }
        }
        
        XLSX.utils.book_append_sheet(wb, availableWs, 'Por Tomar');
        
        // Guardar archivo Excel
        XLSX.writeFile(wb, filename);
        showToast('Reporte Excel generado exitosamente', 'success');
        
    } catch (error) {
        console.error('Error en generateExecutiveReport:', error);
        showToast('Error al generar el reporte: ' + error.message, 'error');
    }
}

function openTaskModal(editId = null) {
    const form = document.getElementById('taskForm');
    form.reset();
    document.getElementById('taskId').value = '';
    document.getElementById('modalTitle').textContent = 'Nuevo Proyecto';
    document.getElementById('btnSaveTask').textContent = 'Guardar Proyecto';
    
    // Reset image preview state
    loadedTaskImageBase64 = null;
    document.getElementById('taskImagePreview').style.display = 'none';
    document.getElementById('taskImagePreview').src = '';
    document.getElementById('btnRemovePreview').style.display = 'none';
    document.getElementById('previewPlaceholder').style.display = 'flex';
    
    // Reset checkboxes
    document.getElementById('taskPhotoShoot').checked = false;
    setBaseTecnicaValue(false);
    document.getElementById('taskPhotoShootRef').value = '';
    togglePhotoRefBox();
    
    // Reset project pauses
    document.getElementById('projectPausesContainer').innerHTML = '';
    pauseCounter = 0;
    
    updateCustomSelectUI('');
    
    if (editId !== null) {
        const t = tasks.find(x => x.id === editId);
        if (t) {
            document.getElementById('taskId').value = t.id;
            document.getElementById('taskName').value = t.name;
            // Support both legacy string and new array format
            const respArr = getResponsiblesArray(t);
            const respVal = JSON.stringify(respArr);
            document.getElementById('taskResponsible').value = respVal;
            updateCustomSelectUI(respVal);
            document.getElementById('taskClient').value = t.client || '';
            document.getElementById('taskCategory').value = t.category;
            document.getElementById('taskStatus').value = t.status;
            document.getElementById('taskPriority').value = t.priority || 'media';
            document.getElementById('taskStart').value = t.start;
            document.getElementById('taskEnd').value = t.end;
            document.getElementById('taskComment').value = t.comment || '';
            
            // Load checkboxes
            document.getElementById('taskPhotoShoot').checked = !!t.photoShoot;
            document.getElementById('taskPhotoShootRef').value = t.photoShootRef || '';
            setBaseTecnicaValue(!!t.baseTecnica);
            togglePhotoRefBox();
            
            // Load project pauses
            if (t.pauses && t.pauses.length > 0) {
                loadProjectPauses(t.pauses);
            }
            
            document.getElementById('modalTitle').textContent = 'Editar Proyecto';
            document.getElementById('btnSaveTask').textContent = 'Actualizar';
            
            // Load preview image if exists
            if (t.image) {
                loadedTaskImageBase64 = t.image;
                const previewImg = document.getElementById('taskImagePreview');
                previewImg.src = t.image;
                previewImg.style.display = 'block';
                document.getElementById('btnRemovePreview').style.display = 'grid';
                document.getElementById('previewPlaceholder').style.display = 'none';
            }
        }
    }
    document.getElementById('taskModal').classList.add('open');
}

function closeModal() { document.getElementById('taskModal').classList.remove('open'); }

async function handleSaveTask(e) {
    e.preventDefault();
    const id = document.getElementById('taskId').value;
    const parsedId = id ? parseInt(id, 10) : null;
    const existing = parsedId ? tasks.find(x => x.id === parsedId) : null;
    const pauses = collectProjectPauses();
    const selectedStatus = document.getElementById('taskStatus').value;
    const updatedAt = new Date().toISOString();
    const data = {
        ...(existing ? (({ _firestoreId, statusManualOverride, ...rest }) => rest)(existing) : {}),
        id: parsedId || Date.now(),
        name: document.getElementById('taskName').value.trim(),
        responsible: (function() {
            try {
                const v = document.getElementById('taskResponsible').value;
                const parsed = JSON.parse(v);
                return Array.isArray(parsed) ? parsed.filter(Boolean) : (v ? [v] : []);
            } catch(e) {
                const v = document.getElementById('taskResponsible').value;
                return v && v.trim() ? [v.trim()] : [];
            }
        })(),
        client: document.getElementById('taskClient').value,
        category: document.getElementById('taskCategory').value,
        status: selectedStatus,
        priority: document.getElementById('taskPriority').value,
        start: document.getElementById('taskStart').value,
        end: document.getElementById('taskEnd').value,
        comment: document.getElementById('taskComment').value.trim(),
        image: loadedTaskImageBase64 ?? existing?.image ?? null,
        photoShoot: document.getElementById('taskPhotoShoot').checked,
        photoShootRef: document.getElementById('taskPhotoShootRef').value.trim(),
        baseTecnica: getBaseTecnicaValue(),
        pauses: pauses,
        statusManualOverride: true, // Siempre establecer a true al editar manualmente
        updatedAt,
    };

    console.log(`💾 Guardando tarea "${data.name}":`, {
        status: data.status,
        statusManualOverride: data.statusManualOverride,
        selectedStatus: selectedStatus
    });

    const saved = await saveTaskToFirestore(data);
    if (!saved) {
        showToast('Error al guardar en la nube', 'error');
        return;
    }

    console.log(`✅ Tarea guardada exitosamente en Firestore`);

    // Actualización local después de guardar exitosamente
    if (existing) {
        Object.assign(existing, data);
        console.log(`🔄 Tarea existente actualizada localmente:`, {
            status: existing.status,
            statusManualOverride: existing.statusManualOverride
        });
    } else {
        tasks.unshift(data);
        console.log(`➕ Nueva tarea agregada localmente`);
    }
    renderAll();

    if (id) { showToast('Tarea actualizada', 'success'); }
    else { showToast('Tarea creada', 'success'); }
    closeModal();
}

function setupFilters() {
    ['filterResponsible', 'filterStatus','filterCategory','filterPriority','filterClient'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderTable);
    });
}

function updateResponsibleFilter() {
    const sel = document.getElementById('filterResponsible');
    if (!sel) return;
    const currVal = sel.value;
    // Collect all individual names from the (possibly array-based) responsible field
    const allNames = new Set();
    tasks.forEach(t => {
        const arr = getResponsiblesArray(t);
        arr.forEach(name => { if (name && name.trim()) allNames.add(name.trim()); });
    });
    const responsibles = [...allNames].sort();
    
    let opts = '<option value="all">Todos los responsables</option>';
    responsibles.forEach(r => { opts += `<option value="${esc(r)}">${esc(r)}</option>`; });
    sel.innerHTML = opts;
    
    if (responsibles.includes(currVal)) sel.value = currVal;
}

function setupCompletedToggle() {
    const tog = document.getElementById('completedToggle');
    if (tog) tog.addEventListener('click', () => {
        const b = document.getElementById('completedBody');
        b.style.display = b.style.display === 'none' ? 'block' : 'none';
        tog.classList.toggle('collapsed');
    });
}

function saveTasks(updatedTask = null) {
    // Si se pasa una tarea específica, guardar solo esa en Firestore
    if (updatedTask) {
        saveTaskToFirestore(updatedTask);
    }
    // onSnapshot se encargará de actualizar la UI automáticamente
}

function showSavedIndicator() {
    const el = document.getElementById('savedIndicator');
    if (!el) return;
    el.classList.add('visible');
    clearTimeout(el._hideTimeout);
    el._hideTimeout = setTimeout(() => el.classList.remove('visible'), 2000);
}

// ==================== EXPORTAR / IMPORTAR JSON ====================
function exportJSON() {
    if (!tasks.length) { showToast('No hay tareas para exportar', 'error'); return; }
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const payload = JSON.stringify({ version: 1, exportedAt: now.toISOString(), tasks }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planner_backup_${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`✅ Backup exportado (${tasks.length} tareas)`, 'success');
}

function importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const data = JSON.parse(reader.result);
                const imported = Array.isArray(data) ? data : (data.tasks || []);
                if (!imported.length) { showToast('El archivo no contiene tareas válidas', 'error'); return; }
                if (!confirm(`¿Importar ${imported.length} tareas? Esto AGREGARÁ las tareas a Firestore.`)) return;
                // Asegurar que cada tarea tenga updatedAt
                imported.forEach(t => { if (!t.updatedAt) t.updatedAt = new Date().toISOString(); });
                await batchImportTasks(imported);
                showToast(`✅ ${imported.length} tareas importadas a Firestore`, 'success');
            } catch(err) {
                showToast('Error al leer el archivo: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

function setupDataButtons() {
    const btnExp = document.getElementById('btnExportJSON');
    const btnImp = document.getElementById('btnImportJSON');
    if (btnExp) btnExp.addEventListener('click', exportJSON);
    if (btnImp) btnImp.addEventListener('click', importJSON);
}

// BOTTLENECK ALERTS
function getBusinessDays(startD, endD) {
    let count = 0; let cur = new Date(startD);
    while (cur <= endD) {
        const d = cur.getDay(); if (d !== 0 && d !== 6) count++;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}
function checkBottlenecks() {
    let changed = false;
    const changedTasks = [];
    tasks.forEach(t => {
        // Respetar estados fijados manualmente desde el modal (p. ej. Ajuste de cambios en revisión)
        const isProtected = isManualStatusProtected(t);
        console.log(`🔍 Check bottlenecks para "${t.name}": status=${t.status}, statusManualOverride=${t.statusManualOverride}, isProtected=${isProtected}`);
        
        if (isProtected) {
            console.log(`✅ Tarea "${t.name}" protegida, no se modifica`);
            return;
        }
        if (t.status === 'completado' || !t.start || !t.end) return;

        const start = new Date(t.start + 'T00:00:00');
        const end = new Date(t.end + 'T23:59:59');
        const now = new Date();
        let shouldMarkCritical = false;

        if (now > start && now <= end) {
            const totalBD = getBusinessDays(start, end) || 1;
            const passedBD = getBusinessDays(start, now);
            if ((passedBD / totalBD) * 100 > 80) shouldMarkCritical = true;
        } else if (now > end) {
            shouldMarkCritical = true;
        }

        if (shouldMarkCritical && t.status !== 'en-critico') {
            console.log(`⚠️ Marcando "${t.name}" como crítico`);
            t.status = 'en-critico';
            t.priority = 'alta';
            t.statusManualOverride = false;
            t.updatedAt = new Date().toISOString();
            changed = true;
            changedTasks.push(t);
            const respNames = getResponsiblesArray(t).join(' & ') || 'Aviso al responsable';
            showToast(`⚠️ Alerta: "${t.name}" ${now > end ? 'está vencida' : 'superó el 80% del tiempo'}. (${respNames})`, 'error');
        }
    });
    
    // NO guardar automáticamente en Firestore para evitar sobrescribir cambios manuales
    // Solo modificar localmente para la visualización
    if (changed && changedTasks.length > 0) {
        console.log(`⚠️ ${changedTasks.length} tareas marcadas como críticas localmente (sin guardar en Firestore)`);
    }
    return changed;
}

function renderAll() { 
    checkBottlenecks();
    updateResponsibleFilter();
    renderStats(); renderTable(); renderGantt(); renderCalendar(); renderAdvancedStats(); renderMarketplace();
}

function renderStats() {
    const total = tasks.length;
    const progress = tasks.filter(t => t.status === 'en-proceso').length;
    const completed = tasks.filter(t => t.status === 'completado').length;
    const critical = tasks.filter(t => t.status === 'en-critico').length;
    const review = tasks.filter(t => t.status === 'ajuste-cambios-revision').length;
    const available = tasks.filter(t => t.status !== 'completado' && !isResponsibleAssigned(t)).length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Actualizar directamente sin animación (igual que en Métricas Challenger)
    const elTotal = document.getElementById('statTotal');
    const elProgress = document.getElementById('statProgress');
    const elCompleted = document.getElementById('statCompleted');
    const elCritical = document.getElementById('statCritical');
    const elAvailable = document.getElementById('statAvailable');
    const elPercent = document.getElementById('progressPercent');
    
    if (elTotal) elTotal.textContent = total;
    if (elProgress) elProgress.textContent = progress;
    if (elCompleted) elCompleted.textContent = completed;
    if (elCritical) elCritical.textContent = critical;
    if (elAvailable) elAvailable.textContent = available;
    if (elPercent) elPercent.textContent = pct + '%';
    
    const ring = document.getElementById('progressRing');
    if (ring) { 
        const c = 2 * Math.PI * 16; 
        ring.style.strokeDasharray = c; 
        ring.style.strokeDashoffset = c - (pct / 100) * c; 
    }
}

function animateNumber(id, target) {
    const el = document.getElementById(id); if (!el) return;
    const cur = parseInt(el.textContent) || 0; if (cur === target) { el.textContent = target; return; }
    const step = target > cur ? 1 : -1; let val = cur;
    const iv = setInterval(() => { val += step; el.textContent = val; if (val === target) clearInterval(iv); }, 60);
}

const catLabels = {'diseno':'🎨 Diseño','ajuste':'🔧 Ajuste','manual':'📘 Manual','pop':'🏷️ POP','catalogo':'📋 Catálogo','cajas':'📦 Cajas','kv':'🖼️ KV','video':'🎬 Video','carrusel':'🎠 Carrusel','banner':'🪧 Banner','etiquetas-retiq':'🔖 Etiquetas Retiq','plotter-corte':'✂️ Plotter de corte','tomo-fotografica':'📸 Tomo fotográfica','reunion':'👥 Reunión','revision-proyectos':'📋 Revisión de proyectos','artwork':'🎨 ArtWork','ficha-tecnica':'📝 Ficha técnica','cajas-tv':'📺 Cajas TV','otros':'📌 Otros'};
const clientLabels = {'id':'ID','id-linea-blanca':'ID · L. Blanca','id-gasodomesticos':'ID · Gasodom.','id-electronica':'ID · Electrónica','id-rta':'ID · RTA','mercadeo':'Mercadeo','ventas':'Ventas','marketing-digital':'Mktg Digital','inbound-challenger':'Inbound','puntos-propios':'Ptos Propios','fundacion-challenger':'Fund. Challenger','sst':'S.S.T','lemco':'LEMCO','exportaciones':'Exportaciones','marketplace':'Marketplace','comercial-alkosto':'Com. ALKOSTO','otros':'Otros','gasodomesticos':'Gasodom.','electronica':'Electrónica','linea-blanca':'L. Blanca','rta':'RTA'};
const statusLabels = {'disponible': 'Disponible', 'no-iniciado':'No Iniciado','planificado':'En revisión','ajuste-cambios-revision':'Ajuste de cambios en revisión','en-proceso':'En Proceso','completado':'Completado','en-critico':'En Crítico'};
const prioLabels = {'alta':'Alta','media':'Media','baja':'Baja'};

function renderAdvancedStats() {
    const cats = document.getElementById('statsCategories'), clis = document.getElementById('statsClients'), prios = document.getElementById('statsPriorities');
    if (!cats || !clis || !prios) return;

    if (!tasks.length) { 
        cats.innerHTML = '<div class="stat-empty-msg">Sin datos</div>'; 
        clis.innerHTML = '<div class="stat-empty-msg">Sin datos</div>'; 
        prios.innerHTML = '<div class="stat-empty-msg">Sin datos</div>'; 
        return; 
    }

    // 1. DONUT WIDGET: Demanda por Categoría
    const totalTasks = tasks.length;
    const cC = {}; tasks.forEach(t => { if(t.category) cC[t.category] = (cC[t.category]||0)+1; });
    const sortedCats = Object.entries(cC).sort((a,b)=>b[1]-a[1]);
    const top3 = sortedCats.slice(0, 3);
    const others = sortedCats.slice(3).reduce((acc, curr) => acc + curr[1], 0);
    if(others > 0) top3.push(['Otros', others]);

    const colors = ['#4f46e5', '#10b981', '#0ea5e9', '#f59e0b']; // Indigo, Emerald, Sky, Amber
    let offset = 0;
    const C = 2 * Math.PI * 40; // approx 251.3
    let circles = `<circle cx="50" cy="50" r="40" stroke="#f1f5f9" stroke-width="12" fill="none"></circle>`;
    let legend = '';
    top3.forEach((c, idx) => {
        const pct = c[1] / totalTasks;
        const dash = pct * C;
        // Leave a small gap (e.g. 3px) between segments if there are multiple items
        const gap = top3.length > 1 ? 3 : 0;
        const actualDash = Math.max(0, dash - gap);
        circles += `<circle cx="50" cy="50" r="40" stroke="${colors[idx]}" stroke-width="12" fill="none" stroke-dasharray="${actualDash} ${C}" stroke-dashoffset="-${offset}" stroke-linecap="round" style="transition: stroke-dasharray 1s ease-out;"></circle>`;
        offset += dash;
        legend += `<div class="donut-legend-item"><div class="donut-legend-left"><span class="donut-dot" style="background:${colors[idx]}"></span><span title="${esc(catLabels[c[0]]||c[0])}">${esc(catLabels[c[0]]||c[0])}</span></div><span class="donut-legend-val">${c[1]}</span></div>`;
    });

    cats.innerHTML = `
        <div class="donut-widget">
            <div class="donut-chart-container">
                <svg viewBox="0 0 100 100" class="donut-svg">${circles}</svg>
                <div class="donut-center">
                    <span class="donut-total">${totalTasks}</span>
                    <span class="donut-label">Total</span>
                </div>
            </div>
            <div class="donut-legend">${legend}</div>
        </div>
    `;

    // 2. LINE WIDGET: Tendencia de Solicitudes (Últimos 14 días)
    const today = new Date(); today.setHours(0,0,0,0);
    const dataPoints = Array(14).fill(0);
    tasks.forEach(t => {
        if(t.end) {
            const d = new Date(t.end + 'T00:00:00');
            const diffDays = Math.floor((today - d) / 864e5);
            if (diffDays >= 0 && diffDays < 14) dataPoints[13 - diffDays]++;
        }
    });
    
    // Smooth random variation just for aesthetics if all are 0
    const maxVal = Math.max(...dataPoints) || 1;
    let points = '';
    for(let i = 0; i < 14; i++) {
        const x = (i / 13) * 200;
        const y = 80 - (dataPoints[i] / maxVal) * 70; // Map to 10-80
        points += `${x},${y} `;
    }

    clis.innerHTML = `
        <div class="line-widget">
            <div class="line-svg-container">
                <svg viewBox="0 0 200 100" class="line-svg" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="rgba(59, 130, 246, 0.2)" />
                            <stop offset="100%" stop-color="rgba(59, 130, 246, 0.0)" />
                        </linearGradient>
                    </defs>
                    <polygon points="0,100 ${points} 200,100" fill="url(#lineGrad)" />
                    <polyline points="${points}" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
            </div>
            <div class="line-x-axis">
                <span>Hace 14 d.</span>
                <span>Hoy</span>
            </div>
        </div>
    `;

    // 3. GAUGE WIDGET: Índice de Riesgo (Alta + Crítico)
    const riskTasks = tasks.filter(t => t.priority === 'alta' || t.status === 'en-critico').length;
    const riskPct = totalTasks > 0 ? (riskTasks / totalTasks) : 0;
    
    const numSegments = 16;
    let gaugePaths = '';
    for(let i = 0; i < numSegments; i++) {
        const startAngle = Math.PI - (i / numSegments) * Math.PI;
        // Leave a gap between segments
        const endAngle = Math.PI - ((i + 0.8) / numSegments) * Math.PI;
        const r = 40;
        const cx = 50, cy = 50;
        
        const x1 = cx + r * Math.cos(startAngle), y1 = cy - r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle), y2 = cy - r * Math.sin(endAngle);
        
        const isFilled = (i / numSegments) < riskPct;
        const color = isFilled ? '#ef4444' : '#f1f5f9'; // Red for risk, light slate for empty
        
        gaugePaths += `<path d="M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}" stroke="${color}" stroke-width="12" stroke-linecap="round" fill="none" style="transition: stroke 0.5s ease ${i*0.03}s;" />`;
    }

    prios.innerHTML = `
        <div class="gauge-widget">
            <div class="gauge-svg-container">
                <svg viewBox="0 0 100 60" class="gauge-svg">
                    ${gaugePaths}
                </svg>
                <div class="gauge-center">
                    <span class="gauge-label">Riesgo</span>
                    <span class="gauge-value">${Math.round(riskPct * 100)}%</span>
                </div>
            </div>
            <div class="gauge-minmax">
                <span>0</span>
                <span>100</span>
            </div>
        </div>
    `;
}

function renderTable() {
    const rf = document.getElementById('filterResponsible').value;
    const sf = document.getElementById('filterStatus').value;
    const cf = document.getElementById('filterCategory').value;
    const pf = document.getElementById('filterPriority').value;
    const clf = document.getElementById('filterClient').value;
    const filtered = tasks.filter(t => {
        if (rf !== 'all') {
            const rArr = getResponsiblesArray(t);
            if (!rArr.includes(rf)) return false;
        }
        if (sf !== 'all' && t.status !== sf) return false;
        if (cf !== 'all' && t.category !== cf) return false;
        if (pf !== 'all' && t.priority !== pf) return false;
        if (clf !== 'all' && t.client !== clf) return false;
        return true;
    });
    const withResponsible = filtered.filter(t => isResponsibleAssigned(t));
    const pending = withResponsible.filter(t => t.status !== 'completado');
    const completed = withResponsible.filter(t => t.status === 'completado');
    const tbody = document.getElementById('taskTableBody');
    const empty = document.getElementById('emptyState');
    const addRow = document.getElementById('addTaskRow');
    if (pending.length === 0 && completed.length === 0) {
        tbody.innerHTML = ''; empty.style.display = 'block'; addRow.style.display = 'none';
        document.querySelector('.table-scroll').style.display = 'none';
    } else {
        empty.style.display = 'none'; addRow.style.display = 'block';
        document.querySelector('.table-scroll').style.display = 'block';
    }
    tbody.innerHTML = pending.map(t => buildRow(t)).join('');
    const cBody = document.getElementById('completedTableBody');
    const cSection = document.getElementById('completedSection');
    const cCount = document.getElementById('completedCount');
    cBody.innerHTML = completed.map(t => buildRow(t)).join('');
    cCount.textContent = completed.length;
    cSection.style.display = completed.length > 0 ? 'block' : 'none';
}

function getProgressInfo(t) {
    if (!t.start || !t.end) return { text: '—', pct: 0, class: 'progress-gray' };
    const start = new Date(t.start + 'T00:00:00'), end = new Date(t.end + 'T23:59:59'), now = new Date();
    const diffMs = end - now;
    let text = diffMs <= 0 ? 'Vencido' : `${Math.floor(diffMs/864e5)}d ${Math.floor((diffMs%864e5)/36e5).toString().padStart(2,'0')}h ${Math.floor((diffMs%36e5)/6e4).toString().padStart(2,'0')}m ${Math.floor((diffMs%6e4)/1e3).toString().padStart(2,'0')}s`;
    
    let pct = 0;
    if (now >= end) pct = 100;
    else if (now > start) {
        const totalBD = getBusinessDays(start, end) || 1;
        pct = (getBusinessDays(start, now) / totalBD) * 100;
    }
    
    let colorClass = 'progress-green';
    if (pct >= 80) colorClass = 'progress-red';
    else if (pct >= 50) colorClass = 'progress-yellow';
    if (t.status === 'completado') colorClass = 'progress-gray';
    
    return { text, pct: Math.min(100, Math.max(0, pct)), class: colorClass };
}

function buildRow(t) {
    const respList = getResponsiblesArray(t);
    const firstName = respList[0] || '';
    const initials = getInitials(firstName);
    const color = stringToColor(firstName);
    const timeline = t.start && t.end ? formatShortDate(t.start) + ' - ' + formatShortDate(t.end) : '—';
    const tlColor = getTimelineColor(t.status);
    const updated = t.updatedAt ? timeAgo(t.updatedAt) : '—';
    const clientDisplay = clientLabels[t.client] || t.client || '—';
    const catDisplay = catLabels[t.category] || t.category || '—';
    const prog = getProgressInfo(t);

    let previewCell = '';
    if (t.image) {
        previewCell = `<img src="${t.image}" class="table-preview-thumbnail" onclick="event.stopPropagation(); openLightbox('${esc(t.image)}', '${esc(t.name)}')" title="Ver vista previa">`;
    } else {
        previewCell = `<div class="table-preview-placeholder" onclick="event.stopPropagation(); openTaskModal(${t.id})" title="Subir vista previa"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>`;
    }

    const pausesCount = t.pauses && t.pauses.length > 0 ? t.pauses.length : 0;
    const pausesDisplay = pausesCount > 0 
        ? `<span class="pauses-badge" title="${t.pauses.map(p => `${p.reason || 'Sin motivo'}: ${p.observation || 'Sin observación'}`).join('\n')}">⏸️ ${pausesCount}</span>` 
        : '<span style="color: var(--text-muted);">—</span>';

    // Build responsible cell for up to 2 members
    const respCellHtml = respList.length === 0
        ? '<span class="avatar-empty">—</span>'
        : respList.map(name =>
            `<span style="display:inline-flex;align-items:center;gap:4px;">
                ${getAvatarHtml(name)}<span class="resp-name">${esc(name)}</span>
            </span>`
          ).join('<span style="color:var(--text-muted);font-size:0.7rem;margin:0 2px;">&</span>');

    return `<tr class="${t.status === 'completado' ? 'row-completed' : ''} ${t.status === 'en-critico' ? 'row-critical' : ''}">
        <td><input type="checkbox" class="task-check" data-id="${t.id}"></td>
        <td class="td-task-name">${esc(t.name)}</td>
        <td>${previewCell}</td>
        <td><div class="responsible-cell">${respCellHtml}</div></td>
        <td><span class="status-badge" data-status="${t.status}">${statusLabels[t.status]}</span></td>
        <td class="td-date">${formatDate(t.end)}</td>
        <td class="td-time-left">
            <div class="bottleneck-container">
                <span class="bottleneck-text ${prog.pct === 100 && t.status !== 'completado' ? 'text-red' : ''}" data-countdown-end="${t.end || ''}" data-status="${t.status}">${prog.text}</span>
                <div class="bottleneck-bar-bg"><div class="bottleneck-bar-fill ${prog.class}" style="width:${prog.pct}%"></div></div>
            </div>
        </td>
        <td><span class="priority-badge priority-${t.priority || 'media'}">${prioLabels[t.priority || 'media']}</span></td>
        <td><span class="client-badge">${esc(clientDisplay)}</span></td>
        <td><span class="cat-badge" data-cat="${t.category}">${catDisplay}</span></td>
        <td class="td-notes" title="${esc(t.comment || '')}">${esc(t.comment || '—')}</td>
        <td>${pausesDisplay}</td>
        <td><span class="timeline-badge" style="background:${tlColor}">${timeline}</span></td>
        <td class="td-updated">${updated}</td>
        <td><div class="task-actions">
            <button class="btn-preview" onclick="openActivityPreviewModal(${t.id})" title="Ver detalle completo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button onclick="openTaskModal(${t.id})" title="Editar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="btn-delete" onclick="deleteTask(${t.id})" title="Eliminar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div></td>
    </tr>`;
}

function renderMarketFlagBadge(isActive, yesText, noText) {
    if (isActive) {
        return `<span class="market-flag market-flag-yes" title="${esc(yesText)}">✔ ${esc(yesText)}</span>`;
    }
    return `<span class="market-flag market-flag-no" title="${esc(noText)}">✕ ${esc(noText)}</span>`;
}

function renderMarketplace() {
    const marketTableBody = document.getElementById('marketTableBody');
    const emptyState = document.getElementById('marketEmptyState');
    const marketScroll = document.getElementById('marketScroll');
    if (!marketTableBody) return;
    
    // Solo mostrar tareas sin asignar (las que tienen el botón "TOMAR TAREA")
    const marketTasks = tasks.filter(t => t.status !== 'completado' && !isResponsibleAssigned(t));
    
    if (marketTasks.length === 0) {
        marketTableBody.innerHTML = '';
        emptyState.style.display = 'block';
        marketScroll.style.display = 'none';
        return;
    }
    
    emptyState.style.display = 'none';
    marketScroll.style.display = 'block';
    
    marketTableBody.innerHTML = marketTasks.map(t => {
        const clientDisplay = clientLabels[t.client] || t.client || '—';
        const catDisplay = catLabels[t.category] || t.category || '—';
        const timeline = t.start && t.end ? formatShortDate(t.start) + ' - ' + formatShortDate(t.end) : '—';
        
        let previewCell = t.image ? `<img src="${t.image}" class="table-preview-thumbnail" onclick="event.stopPropagation(); openLightbox('${esc(t.image)}', '${esc(t.name)}')" title="Ver imagen">` : `<div class="table-preview-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></div>`;
        
        const mktRespList = getResponsiblesArray(t);
        let actionCell = (!isResponsibleAssigned(t)) 
            ? `<div style="display:flex; align-items:center; gap:8px;">
                 <button class="btn-primary" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px;" onclick="takeTask(${t.id})">🙋 Tomar Tarea</button>
                 <button class="btn-icon-sm" onclick="openTaskModal(${t.id})" title="Editar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                 <button class="btn-icon-sm" onclick="deleteTask(${t.id})" title="Eliminar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
               </div>`
            : `<div style="display:flex; align-items:center; gap:8px;">
                 ${mktRespList.map(name => `<span style="font-weight:600; color:var(--accent); font-size:0.75rem; background:var(--bg-secondary); padding:4px 8px; border-radius:12px;">👤 ${esc(name)}</span>`).join('')}
                 <button class="btn-icon-sm" onclick="openTaskModal(${t.id})" title="Editar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                 <button class="btn-icon-sm" onclick="deleteTask(${t.id})" title="Eliminar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
               </div>`;
        
        const photoFlag = renderMarketFlagBadge(!!t.photoShoot, 'Sí', 'No');
        const baseFlag = renderMarketFlagBadge(!!t.baseTecnica, 'Sí', 'No');

        return `<tr>
            <td>${previewCell}</td>
            <td class="td-task-name">${esc(t.name)}</td>
            <td class="td-market-flag">${photoFlag}</td>
            <td class="td-market-flag">${baseFlag}</td>
            <td><span class="client-badge">${esc(clientDisplay)}</span></td>
            <td><span class="cat-badge" data-cat="${t.category}">${catDisplay}</span></td>
            <td><span class="timeline-badge" style="background:#dbeafe">${timeline}</span></td>
            <td>${actionCell}</td>
        </tr>`;
    }).join('');
}

let activeTakeTaskId = null;

function setupTakeTaskModal() {
    const modal = document.getElementById('takeTaskModal');
    if (!modal) return;
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeTakeTaskModal();
    });
}

function takeTask(id) {
    activeTakeTaskId = id;
    const modal = document.getElementById('takeTaskModal');
    const grid = document.getElementById('takeTaskTeamGrid');
    if (!modal || !grid) return;
    
    const teamMembers = ['Diego Rozo', 'Maycol Vargas', 'Daniela Duarte', 'Alexander Peña', 'Daniel Angulo', 'Camilo Davila'];
    
    grid.innerHTML = teamMembers.map(member => {
        return `<button type="button" class="team-member-btn" onclick="confirmTakeTask('${esc(member)}')">
            ${getAvatarHtml(member)}
            <span>${esc(member)}</span>
        </button>`;
    }).join('');
    
    modal.classList.add('open');
}

function closeTakeTaskModal() {
    const modal = document.getElementById('takeTaskModal');
    if (modal) modal.classList.remove('open');
    activeTakeTaskId = null;
}

function confirmTakeTask(name) {
    if (!name || name.trim() === '') return;
    const task = tasks.find(t => t.id === activeTakeTaskId);
    if (task) {
        const updatedTask = { ...task };
        delete updatedTask._firestoreId;
        updatedTask.responsible = [name.trim()];
        updatedTask.status = 'en-proceso';
        updatedTask.updatedAt = new Date().toISOString();
        saveTaskToFirestore(updatedTask);
        showToast('¡Tarea asignada con éxito!', 'success');
        closeTakeTaskModal();
        document.querySelector('.nav-tab[data-view="dashboard"]').click();
    }
}

let pendingDeleteTaskId = null;

function deleteTask(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    pendingDeleteTaskId = id;

    // Show password modal
    const modal = document.getElementById('deletePasswordModal');
    const taskNameEl = document.getElementById('deletePwTaskName');
    const input = document.getElementById('deletePasswordInput');
    const errorEl = document.getElementById('deletePwError');

    taskNameEl.textContent = t.name || 'Sin nombre';
    input.value = '';
    input.type = 'password';
    errorEl.style.display = 'none';
    modal.classList.add('open');
    setTimeout(() => input.focus(), 150);
}

function closeDeletePasswordModal() {
    const modal = document.getElementById('deletePasswordModal');
    modal.classList.remove('open');
    pendingDeleteTaskId = null;
    document.getElementById('deletePasswordInput').value = '';
    document.getElementById('deletePwError').style.display = 'none';
}

function confirmDeleteWithPassword() {
    const input = document.getElementById('deletePasswordInput');
    const errorEl = document.getElementById('deletePwError');
    const pw = input.value;

    if (pw === '9090danielchallenger') {
        // Contraseña correcta — eliminar tarea de Firestore
        deleteTaskFromFirestore(pendingDeleteTaskId);
        closeDeletePasswordModal();
        showToast('Tarea eliminada por administrador', 'info');
    } else {
        // Contraseña incorrecta
        errorEl.style.display = 'flex';
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
        input.value = '';
        input.focus();
    }
}

// Toggle show/hide password + Enter key
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('deletePasswordToggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const input = document.getElementById('deletePasswordInput');
            input.type = input.type === 'password' ? 'text' : 'password';
        });
    }
    const pwInput = document.getElementById('deletePasswordInput');
    if (pwInput) {
        pwInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirmDeleteWithPassword(); }
        });
    }
    const pwModal = document.getElementById('deletePasswordModal');
    if (pwModal) {
        pwModal.addEventListener('click', (e) => {
            if (e.target === pwModal) closeDeletePasswordModal();
        });
    }
});

// GANTT — Vista mensual
const GANTT_DOW = ['DOM', 'L', 'M', 'MI', 'JUE', 'VIE', 'SAB'];
const GANTT_MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function setupGanttNav() {
    document.getElementById('ganttPrev').addEventListener('click', () => {
        currentGanttMonth.setMonth(currentGanttMonth.getMonth() - 1);
        renderGantt();
    });
    document.getElementById('ganttNext').addEventListener('click', () => {
        currentGanttMonth.setMonth(currentGanttMonth.getMonth() + 1);
        renderGantt();
    });
    document.getElementById('ganttToday').addEventListener('click', () => {
        currentGanttMonth = new Date();
        currentGanttMonth.setDate(1);
        currentGanttMonth.setHours(0, 0, 0, 0);
        renderGantt();
    });

    const yearPrev = document.getElementById('ganttYearPrev');
    if (yearPrev) {
        yearPrev.addEventListener('click', () => {
            currentGanttMonth.setFullYear(currentGanttMonth.getFullYear() - 1);
            renderGantt();
        });
    }
    const yearNext = document.getElementById('ganttYearNext');
    if (yearNext) {
        yearNext.addEventListener('click', () => {
            currentGanttMonth.setFullYear(currentGanttMonth.getFullYear() + 1);
            renderGantt();
        });
    }

    // Event listener para el filtro por responsable
    const ganttFilter = document.getElementById('ganttResponsibleFilter');
    const clearGanttFilter = document.getElementById('clearGanttFilter');
    
    if (ganttFilter) {
        ganttFilter.addEventListener('input', () => {
            const filterValue = ganttFilter.value.trim();
            clearGanttFilter.style.display = filterValue ? 'flex' : 'none';
            renderGantt();
        });
    }
    
    if (clearGanttFilter) {
        clearGanttFilter.addEventListener('click', () => {
            ganttFilter.value = '';
            clearGanttFilter.style.display = 'none';
            renderGantt();
        });
    }

    document.getElementById('calendarPrev').addEventListener('click', () => { changeCalendarMonth(-1); });
    document.getElementById('calendarNext').addEventListener('click', () => { changeCalendarMonth(1); });
    document.getElementById('calendarToday').addEventListener('click', () => {
        currentCalendarDate = new Date(); currentCalendarDate.setDate(1); currentCalendarDate.setHours(0,0,0,0);
        renderCalendar();
    });
}

function buildGanttBarHtml(t, leftPct, widthPct) {
    return `<div class="gantt-bar" data-status="${t.status}" style="left:${leftPct}%;width:${widthPct}%;">
        <div class="gantt-bar-waves" aria-hidden="true">
            <div class="gantt-bar-liquid"></div>
            <svg class="gantt-wave-svg gantt-wave-svg-1" viewBox="0 0 200 24" preserveAspectRatio="none">
                <path d="M0,12 C25,4 50,20 75,12 S125,4 150,12 S175,20 200,12 L200,24 L0,24 Z"/>
            </svg>
            <svg class="gantt-wave-svg gantt-wave-svg-2" viewBox="0 0 200 24" preserveAspectRatio="none">
                <path d="M0,14 C25,20 50,8 75,14 S125,20 150,14 S175,8 200,14 L200,24 L0,24 Z"/>
            </svg>
        </div>
        <span class="gantt-bar-label">${esc(t.name)}</span>
    </div>`;
}

function renderGantt() {
    const container = document.getElementById('ganttChart');
    const emptyEl = document.getElementById('ganttEmpty');
    const gc = document.getElementById('ganttContainer');
    if (!container) return;

    const year = currentGanttMonth.getFullYear();
    const month = currentGanttMonth.getMonth();

    let monthStart, monthEnd, yearStart, yearEnd;
    let daysInMonth = 30;

    if (ganttViewMode === 'monthly') {
        daysInMonth = new Date(year, month + 1, 0).getDate();
        monthStart = new Date(year, month, 1);
        monthEnd = new Date(year, month, daysInMonth, 23, 59, 59);

        const monthLabel = document.getElementById('ganttMonthLabel');
        if (monthLabel) monthLabel.textContent = `${GANTT_MONTHS[month]} ${year}`;
    } else {
        yearStart = new Date(year, 0, 1);
        yearEnd = new Date(year, 11, 31, 23, 59, 59);

        const yearLabel = document.getElementById('ganttYearLabel');
        if (yearLabel) yearLabel.textContent = `${year}`;
    }

    // Obtener el valor del filtro por responsable
    const ganttFilterInput = document.getElementById('ganttResponsibleFilter');
    const filterValue = ganttFilterInput ? ganttFilterInput.value.trim().toLowerCase() : '';

    const wt = tasks.filter(t => {
        const fb = (Number(t.id) > 1600000000000) ? new Date(Number(t.id)) : new Date();
        const startStr = t.start || fb.toISOString().split('T')[0];
        const endStr = t.end || startStr;
        const s = new Date(startStr + 'T00:00:00');
        const e = new Date(endStr + 'T23:59:59');
        
        // Filtro por responsable
        let matchesResponsible = true;
        if (filterValue) {
            const respList = getResponsiblesArray(t);
            matchesResponsible = respList.some(name => name.toLowerCase().includes(filterValue));
        }
        
        if (ganttViewMode === 'monthly') {
            return s <= monthEnd && e >= monthStart && isResponsibleAssigned(t) && matchesResponsible;
        } else {
            return s <= yearEnd && e >= yearStart && isResponsibleAssigned(t) && matchesResponsible;
        }
    });

    if (!wt.length) {
        gc.style.display = 'none';
        emptyEl.style.display = 'block';
        if (emptyEl.querySelector('p')) {
            if (ganttViewMode === 'monthly') {
                emptyEl.querySelector('p').textContent = 'No hay tareas programadas para este mes.';
            } else {
                emptyEl.querySelector('p').textContent = 'No hay tareas programadas para este año.';
            }
        }
        return;
    }
    gc.style.display = 'block';
    emptyEl.style.display = 'none';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let gridCols = '';
    if (ganttViewMode === 'monthly') {
        gridCols = `repeat(${daysInMonth}, minmax(0, 1fr))`;
    } else {
        gridCols = `repeat(12, minmax(0, 1fr))`;
    }

    let h = `<div class="gantt-labels">
        <div class="gantt-label-row gantt-corner-cell">
            <span class="gantt-corner-month">${ganttViewMode === 'monthly' ? GANTT_MONTHS[month] : 'AÑO'}</span>
            <span class="gantt-corner-year">${year}</span>
        </div>`;

    wt.forEach(t => {
        const ganttRespList = getResponsiblesArray(t);
        const ganttRespTitle = ganttRespList.length ? ganttRespList.join(' & ') : 'Sin asignar';
        const ganttAvatars = ganttRespList.length
            ? ganttRespList.map(name => getAvatarHtml(name, 'width: 28px; height: 28px; font-size: 0.75rem; margin-right: 2px;')).join('')
            : getAvatarHtml('', 'width: 28px; height: 28px; margin-right: 2px;');
        h += `<div class="gantt-label-row" title="Responsable: ${esc(ganttRespTitle)}">
            <span style="display:inline-flex;align-items:center;margin-right:6px;">${ganttAvatars}</span>
            <span class="gantt-task-name" title="${esc(t.name)}">${esc(t.name)}</span>
        </div>`;
    });

    h += `</div><div class="gantt-timeline" style="--gantt-days:${ganttViewMode === 'monthly' ? daysInMonth : 12}">
        <div class="gantt-month-banner">${ganttViewMode === 'monthly' ? `${GANTT_MONTHS[month]} ${year}` : `PANORAMA ANUAL ${year}`}</div>
        <div class="gantt-days-header" style="grid-template-columns:${gridCols}">`;

    if (ganttViewMode === 'monthly') {
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, month, d);
            const dow = date.getDay();
            const isToday = date.getTime() === today.getTime();
            const isWeekend = dow === 0 || dow === 6;
            h += `<div class="gantt-day-header${isToday ? ' today' : ''}${isWeekend ? ' weekend' : ''}">
                <span class="gantt-dow">${GANTT_DOW[dow]}</span>
                <span class="gantt-dom">${d}</span>
            </div>`;
        }
    } else {
        for (let m = 0; m < 12; m++) {
            const isCurrentMonth = today.getFullYear() === year && today.getMonth() === m;
            h += `<div class="gantt-day-header${isCurrentMonth ? ' today' : ''}" style="padding: 10px 1px;">
                <span class="gantt-dow">${year}</span>
                <span class="gantt-dom" style="font-size: 0.65rem;">${GANTT_MONTHS[m].substring(0, 3)}</span>
            </div>`;
        }
    }

    h += `</div><div class="gantt-rows">`;

    wt.forEach(t => {
        const fb = (Number(t.id) > 1600000000000) ? new Date(Number(t.id)) : new Date();
        const startStr = t.start || fb.toISOString().split('T')[0];
        const endStr = t.end || startStr;
        const ts = new Date(startStr + 'T00:00:00');
        const te = new Date(endStr + 'T23:59:59');

        let leftPct, widthPct;

        if (ganttViewMode === 'monthly') {
            const bs = ts < monthStart ? monthStart : ts;
            const be = te > monthEnd ? monthEnd : te;
            const sd = bs.getDate() - 1;
            const ed = be.getDate() - 1;
            leftPct = (sd / daysInMonth) * 100;
            widthPct = ((ed - sd + 1) / daysInMonth) * 100;
        } else {
            const yearStartMs = yearStart.getTime();
            const yearEndMs = yearEnd.getTime();
            const totalMs = yearEndMs - yearStartMs + 1;
            
            const clampStartMs = Math.max(ts.getTime(), yearStartMs);
            const clampEndMs = Math.min(te.getTime(), yearEndMs);
            
            leftPct = ((clampStartMs - yearStartMs) / totalMs) * 100;
            widthPct = ((clampEndMs - clampStartMs + 1) / totalMs) * 100;
        }

        h += `<div class="gantt-row" style="grid-template-columns:${gridCols}">`;
        if (ganttViewMode === 'monthly') {
            for (let d = 1; d <= daysInMonth; d++) {
                const date = new Date(year, month, d);
                const dow = date.getDay();
                const isToday = date.getTime() === today.getTime();
                const isWeekend = dow === 0 || dow === 6;
                h += `<div class="gantt-cell${isToday ? ' today-col' : ''}${isWeekend ? ' weekend-col' : ''}"></div>`;
            }
        } else {
            for (let m = 0; m < 12; m++) {
                const isCurrentMonth = today.getFullYear() === year && today.getMonth() === m;
                h += `<div class="gantt-cell${isCurrentMonth ? ' today-col' : ''}"></div>`;
            }
        }
        h += buildGanttBarHtml(t, leftPct, widthPct);
        h += '</div>';
    });

    h += '</div></div>';
    container.innerHTML = h;
}

function setGanttViewMode(mode) {
    ganttViewMode = mode;
    
    const btnMonth = document.getElementById('btnGanttMonth');
    const btnYear = document.getElementById('btnGanttYear');
    const ganttTitle = document.getElementById('ganttTitle');
    
    if (btnMonth && btnYear) {
        if (mode === 'monthly') {
            btnMonth.classList.add('active');
            btnYear.classList.remove('active');
            if (ganttTitle) ganttTitle.textContent = 'Vista Mensual — Gantt';
            document.getElementById('ganttNavControls').style.display = 'flex';
            document.getElementById('ganttNavYearControls').style.display = 'none';
        } else {
            btnMonth.classList.remove('active');
            btnYear.classList.add('active');
            if (ganttTitle) ganttTitle.textContent = 'Vista Anual — Gantt';
            document.getElementById('ganttNavControls').style.display = 'none';
            document.getElementById('ganttNavYearControls').style.display = 'flex';
        }
    }
    
    renderGantt();
}

function changeCalendarMonth(offset) {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + offset);
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    if (!grid) return;
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    
    const mn = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    document.getElementById('calendarMonthLabel').textContent = `${mn[month]} ${year}`;
    
    // First day of the month
    const firstDay = new Date(year, month, 1);
    let startDay = firstDay.getDay(); // 0 is Sunday, 1 is Monday
    startDay = startDay === 0 ? 6 : startDay - 1; // Make Monday 0
    
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    
    let html = '';
    
    const today = new Date();
    today.setHours(0,0,0,0);
    
    // Previous month cells
    for (let i = startDay - 1; i >= 0; i--) {
        html += `<div class="calendar-cell other-month"><div class="calendar-cell-date">${daysInPrevMonth - i}</div></div>`;
    }
    
    // Current month cells
    for (let i = 1; i <= daysInMonth; i++) {
        const d = new Date(year, month, i);
        const isToday = d.getTime() === today.getTime();
        const dateStr = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
        
        // Find tasks for this day based on their end date
        const dayTasks = tasks.filter(t => {
            const fb = (Number(t.id) > 1600000000000) ? new Date(Number(t.id)) : new Date();
            const startStr = t.start || fb.toISOString().split('T')[0];
            const endStr = t.end || startStr;
            return endStr === dateStr;
        });
        
        html += `<div class="calendar-cell ${isToday ? 'today' : ''}" onclick="openCalendarDay('${dateStr}')">
            <div class="calendar-cell-date">${i}</div>
            <div class="calendar-events-container">`;
            
        dayTasks.forEach(t => {
            html += `<div class="calendar-event-pill" data-status="${t.status}" onclick="event.stopPropagation(); openCalendarEventModal(${t.id})">
                ${esc(t.name)}
            </div>`;
        });
            
        html += `</div></div>`;
    }
    
    // Next month cells
    const totalCells = startDay + daysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        html += `<div class="calendar-cell other-month"><div class="calendar-cell-date">${i}</div></div>`;
    }
    
    grid.innerHTML = html;
    renderMiniCalendar();
}

function buildMiniCalendarHtml(baseDate, showNav) {
    const year = baseDate.getFullYear();
    const month = baseDate.getMonth();
    const mn = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    
    let navHtml = '';
    if (showNav) {
        navHtml = `
            <div class="mini-cal-nav">
                <button onclick="changeCalendarMonth(-1)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg></button>
                <button onclick="changeCalendarMonth(1)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg></button>
            </div>
        `;
    }
    
    let html = `
        <div class="mini-cal-header">
            <span>${mn[month]} ${year}</span>
            ${navHtml}
        </div>
        <div class="mini-cal-grid">
            <div class="mini-cal-day-label">L</div><div class="mini-cal-day-label">M</div><div class="mini-cal-day-label">X</div><div class="mini-cal-day-label">J</div><div class="mini-cal-day-label">V</div><div class="mini-cal-day-label">S</div><div class="mini-cal-day-label">D</div>
    `;
    
    const firstDay = new Date(year, month, 1);
    let startDay = firstDay.getDay(); 
    startDay = startDay === 0 ? 6 : startDay - 1;
    
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    today.setHours(0,0,0,0);
    
    for (let i = startDay - 1; i >= 0; i--) {
        html += `<div class="mini-cal-cell other-month">${daysInPrevMonth - i}</div>`;
    }
    
    for (let i = 1; i <= daysInMonth; i++) {
        const d = new Date(year, month, i);
        const isToday = d.getTime() === today.getTime();
        const dateStr = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
        html += `<div class="mini-cal-cell ${isToday ? 'today' : ''}" onclick="openCalendarDay('${dateStr}')">${i}</div>`;
    }
    
    const totalCells = startDay + daysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        html += `<div class="mini-cal-cell other-month">${i}</div>`;
    }
    
    html += `</div>`;
    return html;
}

function renderMiniCalendar() {
    const mini = document.getElementById('miniCalendar');
    if (mini) {
        mini.innerHTML = buildMiniCalendarHtml(currentCalendarDate, true);
    }
    
    const nextMini = document.getElementById('nextMiniCalendar');
    if (nextMini) {
        const nextMonthDate = new Date(currentCalendarDate.getFullYear(), currentCalendarDate.getMonth() + 1, 1);
        nextMini.innerHTML = buildMiniCalendarHtml(nextMonthDate, false);
    }
}

function openCalendarDay(dateStr) {
    document.getElementById('taskEnd').value = dateStr;
    openTaskModal();
}

function openCalendarEventModal(taskId) {
    const t = tasks.find(x => x.id === taskId);
    if(!t) return;
    document.getElementById('calEventTitle').textContent = t.name;
    
    const fb = (Number(t.id) > 1600000000000) ? new Date(Number(t.id)) : new Date();
    const startStr = t.start || fb.toISOString().split('T')[0];
    const endStr = t.end || startStr;
    
    document.getElementById('calEventTime').textContent = `Vence: ${formatDate(endStr)}`;
    
    const calRespList = getResponsiblesArray(t);
    if(calRespList.length) {
        document.getElementById('calEventAvatar').innerHTML = calRespList.map(name => getAvatarHtml(name)).join('');
        document.getElementById('calEventResponsible').textContent = calRespList.join(' & ');
    } else {
        document.getElementById('calEventAvatar').innerHTML = '<span class="avatar-empty">—</span>';
        document.getElementById('calEventResponsible').textContent = 'Sin asignar';
    }
    
    document.getElementById('calEventDescription').textContent = t.desc || 'Sin descripción';
    
    document.getElementById('calEventOpenBtn').onclick = () => {
        closeCalendarEventModal();
        openTaskModal(t.id);
    };
    
    document.getElementById('calendarEventModal').style.display = 'flex';
}

function closeCalendarEventModal() {
    document.getElementById('calendarEventModal').style.display = 'none';
}

// REPORT
function setupReportButtons() {
    document.getElementById('btnGenerateReport').addEventListener('click', generateReport);
    document.getElementById('btnCopyReport').addEventListener('click', () => { navigator.clipboard.writeText(lastMD).then(() => showToast('Copiado', 'success')); });
    document.getElementById('btnExportReport').addEventListener('click', () => {
        const b = new Blob([lastMD], {type:'text/markdown'}), u = URL.createObjectURL(b), a = document.createElement('a');
        a.href = u; a.download = `reporte_semana_${getWeekNumber(new Date())}.md`; a.click(); URL.revokeObjectURL(u); showToast('Descargado', 'success');
    });
}
let lastMD = '';
function generateReport() {
    if (!tasks.length) { showToast('Agrega tareas primero', 'error'); return; }
    const total = tasks.length, comp = tasks.filter(t => t.status==='completado'), prog = tasks.filter(t => t.status==='en-proceso'), crit = tasks.filter(t => t.status==='en-critico');
    const pct = Math.round((comp.length/total)*100), now = new Date(), mn = ['Enero','Feb','Marzo','Abril','Mayo','Junio','Julio','Agosto','Sep','Oct','Nov','Dic'];
    let md = `# 🗂️ Reporte Semanal — Semana ${getWeekNumber(now)}\n> **Fecha:** ${now.getDate()} de ${mn[now.getMonth()]} ${now.getFullYear()} | **Tareas:** ${total}\n\n---\n\n`;
    md += `## 📊 Avance Global: ${pct}%\n\n`;
    if (comp.length) { md += `## ✅ Completadas\n`; comp.forEach(t => { md += `- **${t.name}** (${t.responsible || '—'}) — ${t.comment || 'Cerrado'}\n`; }); md += '\n'; }
    if (prog.length) { md += `## 🔄 En Proceso\n`; prog.forEach(t => { md += `- **${t.name}** (${t.responsible || '—'})\n`; }); md += '\n'; }
    if (crit.length) { md += `## 🚨 En Crítico\n`; crit.forEach(t => { md += `- **${t.name}** — ${t.comment || 'Sin detalle'}\n`; }); md += '\n'; }
    md += `---\n_PM Control Center · Equipo Publicidad Challenger_\n`;
    lastMD = md;
    document.getElementById('reportContent').innerHTML = `<div class="report-rendered">${mdToHtml(md)}</div>`;
    document.getElementById('btnCopyReport').style.display = 'inline-flex';
    document.getElementById('btnExportReport').style.display = 'inline-flex';
    showToast('Reporte generado', 'success');
}
function mdToHtml(md) {
    let h = md.replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^> (.+)$/gm,'<p style="padding-left:12px;border-left:3px solid var(--accent);color:var(--text-secondary);font-size:0.85rem;">$1</p>').replace(/^---$/gm,'<div class="report-divider"></div>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/_(.+?)_/g,'<em>$1</em>').replace(/^- (.+)$/gm,'<li>$1</li>');
    h = h.replace(/(<li>.*<\/li>)/s,'<ul>$1</ul>').replace(/<\/ul>\s*<ul>/g,'');
    return h.split('\n').map(l => { const t = l.trim(); if (!t) return ''; if (t.startsWith('<')) return t; return `<p>${t}</p>`; }).join('\n');
}

// UTILITIES
function getMonday(d) { const dt = new Date(d), dy = dt.getDay(); dt.setDate(dt.getDate() - dy + (dy===0?-6:1)); dt.setHours(0,0,0,0); return dt; }
function getWeekNumber(d) { const dt = new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); const dn = dt.getUTCDay()||7; dt.setUTCDate(dt.getUTCDate()+4-dn); const ys = new Date(Date.UTC(dt.getUTCFullYear(),0,1)); return Math.ceil((((dt-ys)/864e5)+1)/7); }
function formatDate(ds) { if (!ds) return '—'; const p=ds.split('-'), m=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']; return m[parseInt(p[1])-1]+'. '+parseInt(p[2]); }
function formatShortDate(ds) { if (!ds) return ''; const p=ds.split('-'), m=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']; return m[parseInt(p[1])-1]+'. '+parseInt(p[2]); }
function capitalize(s) { return s.charAt(0).toUpperCase()+s.slice(1); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function getStatusColor(s) { return {'no-iniciado':'#9ca3af','planificado':'#3b82f6','ajuste-cambios-revision':'#8b5cf6','en-proceso':'#f59e0b','completado':'#10b981','en-critico':'#ef4444'}[s]||'#9ca3af'; }
function getTimelineColor(s) { return {'no-iniciado':'#f3f4f6','planificado':'#dbeafe','ajuste-cambios-revision':'#ede9fe','en-proceso':'#fef3c7','completado':'#d1fae5','en-critico':'#fecaca'}[s]||'#f3f4f6'; }
function getInitials(n) { if (!n) return '?'; const p=n.trim().split(' '); return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():p[0].substring(0,2).toUpperCase(); }
function stringToColor(s) { if (!s) return '#9ca3af'; let h=0; for(let i=0;i<s.length;i++) h=s.charCodeAt(i)+((h<<5)-h); const c=['#6366f1','#ec4899','#0891b2','#ea580c','#7c3aed','#059669','#d97706','#dc2626']; return c[Math.abs(h)%c.length]; }

function getAvatarHtml(name, extraStyles = '') {
    if (!name) return '<span class="avatar-empty">—</span>';
    const customAvatars = cachedAvatars;
    const initials = getInitials(name);
    const color = stringToColor(name);
    const n = name.trim().toLowerCase();
    let imgSrc = customAvatars[name] || null;
    
    if (!imgSrc) {
        if (n.includes('diego')) imgSrc = 'team/Diego Rozo.png';
        else if (n.includes('maycol')) imgSrc = 'team/Maycol.png';
        else if (n.includes('alex')) imgSrc = 'team/Alex.png';
        else if (n.includes('daniela')) imgSrc = 'team/Daniel_duarte.png';
        else if (n === 'daniel angulo' || n === 'daniel') imgSrc = 'team/Daniel.png';
        else if (n.includes('camilo')) imgSrc = 'team/Camilo Davila.png';
    }

    if (imgSrc) {
        return `<img src="${imgSrc}" class="avatar-img" style="${extraStyles}; cursor:pointer;" alt="${esc(name)}" ondblclick="openProfileModal('${esc(name)}')" title="Doble clic para personalizar perfil" />`;
    } else {
        return `<span class="avatar-circle" style="background:${color}; ${extraStyles}; cursor:pointer;" ondblclick="openProfileModal('${esc(name)}')" title="Doble clic para personalizar perfil">${initials}</span>`;
    }
}
function timeAgo(iso) { const d=Date.now()-new Date(iso).getTime(), m=Math.floor(d/6e4); if(m<1) return 'Ahora'; if(m<60) return `Hace ${m} min`; const h=Math.floor(m/60); if(h<24) return `Hace ${h} hr`; return `Hace ${Math.floor(h/24)} d`; }
function showToast(msg, type='info') { const c=document.getElementById('toastContainer'), t=document.createElement('div'); t.className=`toast ${type}`; t.textContent=msg; c.appendChild(t); setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(30px)';setTimeout(()=>t.remove(),300);},3000); }

// ==================== IMAGE PREVIEW & UPLOAD ====================
function setupImageUpload() {
    const box = document.getElementById('previewUploadBox');
    const input = document.getElementById('taskImageInput');
    const btnRemove = document.getElementById('btnRemovePreview');

    if (!box || !input) return;

    box.addEventListener('click', (e) => {
        if (e.target !== btnRemove && !btnRemove.contains(e.target)) {
            input.click();
        }
    });

    input.addEventListener('change', () => {
        const file = input.files[0];
        if (file) handleImageFile(file);
    });

    // Drag and drop events
    ['dragenter', 'dragover'].forEach(name => {
        box.addEventListener(name, (e) => {
            e.preventDefault(); e.stopPropagation();
            box.style.borderColor = 'var(--accent)';
            box.style.background = 'var(--accent-light)';
        });
    });

    ['dragleave', 'drop'].forEach(name => {
        box.addEventListener(name, (e) => {
            e.preventDefault(); e.stopPropagation();
            box.style.borderColor = '';
            box.style.background = '';
        });
    });

    box.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) handleImageFile(file);
    });

    btnRemove.addEventListener('click', (e) => {
        e.stopPropagation();
        loadedTaskImageBase64 = null;
        input.value = '';
        document.getElementById('taskImagePreview').style.display = 'none';
        document.getElementById('taskImagePreview').src = '';
        btnRemove.style.display = 'none';
        document.getElementById('previewPlaceholder').style.display = 'flex';
    });
}

function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        // Comprimir imagen antes de guardar
        compressImage(e.target.result, 400, 0.60, (compressed) => {
            loadedTaskImageBase64 = compressed;
            const previewImg = document.getElementById('taskImagePreview');
            previewImg.src = compressed;
            previewImg.style.display = 'block';
            document.getElementById('btnRemovePreview').style.display = 'grid';
            document.getElementById('previewPlaceholder').style.display = 'none';
        });
    };
    reader.readAsDataURL(file);
}

function compressImage(dataUrl, maxPx, quality, callback) {
    const img = new Image();
    img.onload = () => {
        let { width, height } = img;
        if (width > maxPx || height > maxPx) {
            if (width > height) { height = Math.round(height * maxPx / width); width = maxPx; }
            else { width = Math.round(width * maxPx / height); height = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        callback(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => callback(dataUrl); // fallback sin compresión
    img.src = dataUrl;
}

// ==================== LIGHTBOX POP-UP ====================
function setupLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    if (!overlay) return;

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeLightbox();
    });
    const btnLightboxClose = document.querySelector('.lightbox-close');
    if (btnLightboxClose) btnLightboxClose.addEventListener('click', closeLightbox);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) closeLightbox();
    });
}

function openLightbox(src, caption) {
    const overlay = document.getElementById('lightboxOverlay');
    const img = document.getElementById('lightboxImage');
    const cap = document.getElementById('lightboxCaption');
    if (!overlay || !img) return;

    img.src = src;
    cap.textContent = caption;
    overlay.style.display = 'grid';
    setTimeout(() => overlay.classList.add('open'), 10);
}

function closeLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(() => overlay.style.display = 'none', 250);
}

// ==================== ACTIVITY PREVIEW MODAL ====================
function setupActivityPreviewModal() {
    const modal = document.getElementById('activityPreviewModal');
    const btnClose = document.getElementById('btnClosePreviewModal');
    if (!modal || !btnClose) return;
    
    btnClose.addEventListener('click', closeActivityPreviewModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeActivityPreviewModal(); });
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeActivityPreviewModal();
    });
}

function openActivityPreviewModal(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;

    // Load data
    document.getElementById('prevTaskName').textContent = t.name;
    
    const prevRespList = getResponsiblesArray(t);
    const respHtml = prevRespList.length
        ? prevRespList.map(name =>
            `${getAvatarHtml(name, 'display:inline-block; vertical-align:middle; width:44px; height:44px; font-size:1.1rem; margin-right:8px;')}<span style="vertical-align:middle;">${esc(name)}</span>`
          ).join('<span style="margin:0 6px;color:var(--text-muted);">&</span>')
        : '<span class="avatar-empty">—</span>';
    document.getElementById('prevTaskResponsible').innerHTML = respHtml;

    
    const clientDisplay = clientLabels[t.client] || t.client || '—';
    document.getElementById('prevTaskClient').innerHTML = `<span class="client-badge" style="margin:0;">${esc(clientDisplay)}</span>`;
    
    const catDisplay = catLabels[t.category] || t.category || '—';
    document.getElementById('prevTaskCategory').innerHTML = `<span class="cat-badge" data-cat="${t.category}" style="margin:0;">${esc(catDisplay)}</span>`;
    
    document.getElementById('prevTaskStatus').innerHTML = `<span class="status-badge" data-status="${t.status}" style="margin:0;">${statusLabels[t.status]}</span>`;
    
    document.getElementById('prevTaskEnd').textContent = t.end ? formatDate(t.end) : '—';
    
    document.getElementById('prevTaskPriority').innerHTML = `<span class="priority-badge priority-${t.priority || 'media'}" style="margin:0;">${prioLabels[t.priority || 'media']}</span>`;
    
    // Load checkboxes in preview
    document.getElementById('prevTaskPhotoShoot').innerHTML = t.photoShoot ? '<span style="color:#10b981; font-weight:600;">✔️ Sí</span>' : '<span style="color:#ef4444; font-weight:600;">❌ No</span>';
    const photoRefWrap = document.getElementById('prevPhotoRefWrap');
    const photoRefEl = document.getElementById('prevTaskPhotoRef');
    if (photoRefWrap && photoRefEl) {
        const hasRef = t.photoShoot && t.photoShootRef && t.photoShootRef.trim();
        photoRefWrap.style.display = hasRef ? 'flex' : 'none';
        photoRefEl.textContent = hasRef ? t.photoShootRef : '—';
    }
    
    document.getElementById('prevTaskBaseTecnica').innerHTML = t.baseTecnica ? '<span style="color:#10b981; font-weight:600;">✔️ Sí</span>' : '<span style="color:#ef4444; font-weight:600;">❌ No</span>';
    
    document.getElementById('prevTaskComment').textContent = t.comment ? t.comment : 'Sin brief registrado.';
    
    // Load Image/Media Preview
    const img = document.getElementById('prevTaskImage');
    const noImg = document.getElementById('prevTaskNoImage');
    if (t.image) {
        img.src = t.image;
        img.style.display = 'block';
        noImg.style.display = 'none';
    } else {
        img.src = '';
        img.style.display = 'none';
        noImg.style.display = 'flex';
    }

    document.getElementById('activityPreviewModal').classList.add('open');
}

function closeActivityPreviewModal() {
    const modal = document.getElementById('activityPreviewModal');
    if (!modal) return;
    modal.classList.remove('open');
}

// REAL-TIME COUNTDOWN UPDATER
setInterval(() => {
    document.querySelectorAll('.bottleneck-text[data-countdown-end]').forEach(el => {
        const endStr = el.getAttribute('data-countdown-end');
        if (!endStr) return;
        const status = el.getAttribute('data-status');
        if (status === 'completado') return; 
        
        const end = new Date(endStr + 'T23:59:59');
        const diffMs = end - new Date();
        if (diffMs <= 0) {
            if (el.textContent !== 'Vencido') el.textContent = 'Vencido';
            if (!el.classList.contains('text-red')) el.classList.add('text-red');
        } else {
            const d = Math.floor(diffMs/864e5);
            const h = Math.floor((diffMs%864e5)/36e5).toString().padStart(2,'0');
            const m = Math.floor((diffMs%36e5)/6e4).toString().padStart(2,'0');
            const s = Math.floor((diffMs%6e4)/1e3).toString().padStart(2,'0');
            el.textContent = `${d}d ${h}h ${m}m ${s}s`;
            if (el.classList.contains('text-red')) el.classList.remove('text-red');
        }
    });
}, 1000);

// ==================== TRADING METRICS DASHBOARD ====================
let tdTrendChartInstance = null;
let tdStatusChartInstance = null;
let tdMonthlyVolumeChartInstance = null;
let tdWeeklyVolumeChartInstance = null;
let tdLiveInterval = null;
let tdClockInterval = null;
let tdTrendSeries = [];
let tdActiveTimeframe = '1h';

const TD_NEON = ['#00ff88','#00d4ff','#ffcc00','#ff9f0a','#bf5af2','#ff2d55','#34ffe5','#ff6b35'];
/** Colores fijos por usuario — solo sección Métricas Challenger */
const TD_USER_COLORS = {
    'Maycol Vargas': '#00ff88',
    'Diego Rozo': '#00d4ff',
    'Daniela Duarte': '#ffcc00',
    'Alexander Peña': '#bf5af2',
    'Daniel Angulo': '#ff9f0a',
    'Camilo Davila': '#ff2d55',
};

function getTdUserColor(name) {
    if (TD_USER_COLORS[name]) return TD_USER_COLORS[name];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return TD_NEON[Math.abs(h) % TD_NEON.length];
}

function getTdResponsibleLoads() {
    const loads = {};
    tasks.forEach(t => {
        if (t.status === 'completado') return;
        const arr = getResponsiblesArray(t);
        arr.forEach(name => {
            if (name && name.trim()) loads[name] = (loads[name] || 0) + 1;
        });
    });
    return loads;
}

function getSeriesVolatility(load, maxLoad) {
    if (maxLoad <= 0) return 0.55;
    const ratio = load / maxLoad;
    return 0.42 + ratio * 1.05;
}

function getTrendLineTension(vol) {
    return vol > 0.65 ? 0.04 : vol > 0.4 ? 0.1 : 0.18;
}

function seriesRecentVolatility(data) {
    if (data.length < 4) return 0;
    const slice = data.slice(-12);
    let sum = 0;
    for (let i = 1; i < slice.length; i++) sum += Math.abs(slice[i].y - slice[i - 1].y);
    return sum / (slice.length - 1);
}
const clientLabelsShort = {
    'id': 'ID', 'id-linea-blanca': 'ID · L. Blanca', 'id-gasodomesticos': 'ID · Gasodom.',
    'id-electronica': 'ID · Electrónica', 'id-rta': 'ID · RTA',
    'mercadeo': 'Mercadeo', 'ventas': 'Ventas', 'visual': 'Dpto. Visual',
    'marketing-digital': 'Mkt Digital', 'inbound-challenger': 'Inbound',
    'puntos-propios': 'Puntos', 'fundacion-challenger': 'Fund. Challenger',
    'sst': 'S.S.T', 'lemco': 'LEMCO', 'exportaciones': 'Exportaciones',
    'marketplace': 'Marketplace', 'comercial-alkosto': 'ALKOSTO', 'otros': 'Otros',
    'gasodomesticos': 'Gasodom.', 'electronica': 'Electrónica',
    'linea-blanca': 'L. Blanca', 'rta': 'RTA'
};
const catLabelsShort = {
    'diseno': '🎨 Diseño', 'ajuste': '🔧 Ajuste', 'manual': '📘 Manual',
    'pop': '🏷️ POP', 'catalogo': '📋 Catálogo',
    'cajas': '📦 Cajas', 'kv': '🖼️ KV', 'video': '🎬 Video', 'carrusel': '🎠 Carrusel',
    'banner': '🪧 Banner', 'etiquetas-retiq': '🔖 Etiquetas Retiq',
    'plotter-corte': '✂️ Plotter corte', 'tomo-fotografica': '📸 Tomo fotográfica',
    'reunion': '👥 Reunión', 'revision-proyectos': '📋 Revisión proyectos',
    'artwork': '🎨 ArtWork', 'ficha-tecnica': '📝 Ficha técnica', 'cajas-tv': '📺 Cajas TV',
    'serigrafia': '🖌️ Serigrafía', 'exhibicion': '🏛️ Exhibición',
    'digital': '💻 Digital', 'piezas': '🖼 Piezas',
    'etiquetas': '🔖 Etiquetas',
    'publicidad': '📣 Publicidad', 'empaque': '📦 Empaque', 'otros': '📌 Otros', 'otro': '🗂 Otro'
};

function setupMetricsNav() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.dataset.view === 'report') {
                setTimeout(() => renderMetrics(), 80);
            } else if (tab.dataset.view === 'dashboard') {
                setTimeout(() => renderStats(), 80);
            } else {
                stopMetricsLive();
            }
        });
    });

    // Timeframe buttons
    document.addEventListener('click', e => {
        const btn = e.target.closest('.td-tf-btn');
        if (!btn) return;
        document.querySelectorAll('.td-tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tdActiveTimeframe = btn.dataset.tf;
        rebuildTrendData();
        updateTrendChart();
    });
}

const TD_WORLD_CITIES = [
    { label: 'Colombia', sub: 'BOG', tz: 'America/Bogota', neon: '#00ff88' },
    { label: 'New York', sub: 'NYC', tz: 'America/New_York', neon: '#00d4ff' },
    { label: 'Londres', sub: 'UK', tz: 'Europe/London', neon: '#bf5af2' },
    { label: 'Hong Kong', sub: 'HK', tz: 'Asia/Hong_Kong', neon: '#ffcc00' },
    { label: 'Dubái', sub: 'EAU', tz: 'Asia/Dubai', neon: '#ff9f0a' },
    { label: 'Fráncfort', sub: 'ALE', tz: 'Europe/Berlin', neon: '#ff2d55' },
];

const TD_CAL_MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const TD_CAL_WEEKDAYS = ['L','M','X','J','V','S','D'];

function getZonedTime(tz) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const get = type => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
    return { h: get('hour'), m: get('minute'), s: get('second') };
}

function renderTdCalendar() {
    const el = document.getElementById('tdCalendar');
    const badge = document.getElementById('tdCalMonthBadge');
    if (!el) return;

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const today = now.getDate();

    if (badge) badge.textContent = `${TD_CAL_MONTHS[month].toUpperCase()} ${year}`;

    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysPrevMonth = new Date(year, month, 0).getDate();

    let daysHtml = '';
    for (let i = 0; i < firstWeekday; i++) {
        const d = daysPrevMonth - firstWeekday + i + 1;
        daysHtml += `<span class="td-cal-day other-month">${d}</span>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const cls = d === today ? 'td-cal-day today' : 'td-cal-day';
        daysHtml += `<span class="${cls}">${d}</span>`;
    }
    const totalCells = firstWeekday + daysInMonth;
    const trailing = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 1; i <= trailing; i++) {
        daysHtml += `<span class="td-cal-day other-month">${i}</span>`;
    }

    const weekdays = TD_CAL_WEEKDAYS.map(w => `<span class="td-cal-weekday">${w}</span>`).join('');

    el.innerHTML = `
        <div class="td-cal-month-title">${TD_CAL_MONTHS[month]} ${year}</div>
        <div class="td-cal-weekdays">${weekdays}</div>
        <div class="td-cal-days">${daysHtml}</div>
    `;
}

function buildDigitalClockMarkup(city, i) {
    const id = `clock-${i}`;
    const neon = city.neon;
    return `<div class="td-neon-clock-card" data-clock-id="${id}" data-tz="${esc(city.tz)}" style="--neon:${neon};">
        <span class="td-neon-clock-label">${esc(city.label)}</span>
        <span class="td-neon-clock-time" data-digital="${id}">00:00:00</span>
        <span class="td-neon-clock-sub">${esc(city.sub)}</span>
    </div>`;
}

function setupMetricsVideo() {
    const video = document.getElementById('tdMetricsVideo');
    const btn = document.getElementById('tdVideoSoundBtn');
    const iconOff = document.getElementById('tdSoundIconOff');
    const iconOn = document.getElementById('tdSoundIconOn');
    if (!video) return;

    // Ensure video plays muted (autoplay policy)
    video.muted = true;
    if (video.paused) {
        video.play().catch(() => {});
    }

    // Audio toggle button
    if (btn) {
        btn.addEventListener('click', () => {
            video.muted = !video.muted;
            if (video.muted) {
                btn.classList.remove('is-unmuted');
                if (iconOff) iconOff.style.display = '';
                if (iconOn) iconOn.style.display = 'none';
                btn.title = 'Activar audio';
            } else {
                btn.classList.add('is-unmuted');
                if (iconOff) iconOff.style.display = 'none';
                if (iconOn) iconOn.style.display = '';
                btn.title = 'Desactivar audio';
                // Make sure it's playing
                if (video.paused) video.play().catch(() => {});
            }
        });
    }
}

function renderMetrics() {
    if (!document.getElementById('tdClock')) return;
    renderTdHeader();
    renderTdCalendar();
    setupMetricsVideo();
    renderTdCats();
    renderTdClients();
    renderTdStatus();
    renderTdPauses();
    renderTdMonthlyVolumeChart();
    renderTdWeeklyVolumeChart();
    renderTdAnimatedMetric();
    renderTdSmallMetric();
    startMetricsLive();
}

function stopMetricsLive() {
    if (tdLiveInterval) { clearInterval(tdLiveInterval); tdLiveInterval = null; }
    if (tdClockInterval) { clearInterval(tdClockInterval); tdClockInterval = null; }
    // No destruir las gráficas de volumen al cambiar de sección
    // if (tdMonthlyVolumeChartInstance) { tdMonthlyVolumeChartInstance.destroy(); tdMonthlyVolumeChartInstance = null; }
    // if (tdWeeklyVolumeChartInstance) { tdWeeklyVolumeChartInstance.destroy(); tdWeeklyVolumeChartInstance = null; }
}

// ── HEADER: clock + stats ──
function renderTdHeader() {
    const total = tasks.length;
    const inProgress = tasks.filter(t => t.status === 'en-proceso').length;
    const done = tasks.filter(t => t.status === 'completado').length;
    const critical = tasks.filter(t => t.status === 'en-critico').length;
    const review = tasks.filter(t => t.status === 'ajuste-cambios-revision').length;
    const available = tasks.filter(t => t.status !== 'completado' && !isResponsibleAssigned(t)).length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    const elTotal = document.getElementById('tdTotalTasks');
    const elPct   = document.getElementById('tdCompletedPct');
    if (elTotal) elTotal.textContent = `${total} TAREAS`;
    if (elPct)   elPct.textContent   = `${pct}% COMPLETADO`;

    // Update status metrics panel
    const elMetricTotal = document.getElementById('tdMetricTotal');
    const elMetricProgress = document.getElementById('tdMetricProgress');
    const elMetricCompleted = document.getElementById('tdMetricCompleted');
    const elMetricReview = document.getElementById('tdMetricReview');
    const elMetricCritical = document.getElementById('tdMetricCritical');
    const elMetricPauses = document.getElementById('tdMetricPauses');
    const elMetricAvailable = document.getElementById('tdMetricAvailable');
    const elProgressPercent = document.getElementById('tdProgressPercent');
    const elProgressRing = document.getElementById('tdProgressRing');

    // Count total pauses
    let totalPauses = 0;
    tasks.forEach(t => {
        if (t.pauses && t.pauses.length > 0) {
            totalPauses += t.pauses.length;
        }
    });

    if (elMetricTotal) elMetricTotal.textContent = total;
    if (elMetricProgress) elMetricProgress.textContent = inProgress;
    if (elMetricCompleted) elMetricCompleted.textContent = done;
    if (elMetricReview) elMetricReview.textContent = review;
    if (elMetricCritical) elMetricCritical.textContent = critical;
    if (elMetricPauses) elMetricPauses.textContent = totalPauses;
    if (elMetricAvailable) elMetricAvailable.textContent = available;
    if (elProgressPercent) elProgressPercent.textContent = `${pct}%`;
    if (elProgressRing) {
        const c = 2 * Math.PI * 16;
        elProgressRing.style.strokeDasharray = c;
        elProgressRing.style.strokeDashoffset = c - (pct / 100) * c;
    }

    // Update duplicate metrics panel (dark theme)
    const elMetricTotalDark = document.getElementById('tdMetricTotalDark');
    const elMetricProgressDark = document.getElementById('tdMetricProgressDark');
    const elMetricCompletedDark = document.getElementById('tdMetricCompletedDark');
    const elMetricReviewDark = document.getElementById('tdMetricReviewDark');
    const elMetricCriticalDark = document.getElementById('tdMetricCriticalDark');
    const elMetricAvailableDark = document.getElementById('tdMetricAvailableDark');
    const elProgressPercentDark = document.getElementById('tdProgressPercentDark');
    const elProgressRingDark = document.getElementById('tdProgressRingDark');

    if (elMetricTotalDark) elMetricTotalDark.textContent = total;
    if (elMetricProgressDark) elMetricProgressDark.textContent = inProgress;
    if (elMetricCompletedDark) elMetricCompletedDark.textContent = done;
    if (elMetricReviewDark) elMetricReviewDark.textContent = review;
    if (elMetricCriticalDark) elMetricCriticalDark.textContent = critical;
    if (elMetricAvailableDark) elMetricAvailableDark.textContent = available;
    if (elProgressPercentDark) elProgressPercentDark.textContent = `${pct}%`;
    if (elProgressRingDark) {
        const c = 2 * Math.PI * 16;
        elProgressRingDark.style.strokeDasharray = c;
        elProgressRingDark.style.strokeDashoffset = c - (pct / 100) * c;
    }

    // Clock
    if (tdClockInterval) clearInterval(tdClockInterval);
    function tickClock() {
        const now = new Date();
        const hh = now.getHours().toString().padStart(2,'0');
        const mm = now.getMinutes().toString().padStart(2,'0');
        const ss = now.getSeconds().toString().padStart(2,'0');
        const el = document.getElementById('tdClock');
        if (el) el.textContent = `${hh}:${mm}:${ss}`;
    }
    tickClock();
    tdClockInterval = setInterval(tickClock, 1000);
}

// ── TEAM RANKING ──
function renderTdTeam() {
    const el = document.getElementById('tdTeamList');
    if (!el) return;

    const counts = {};
    tasks.forEach(t => {
        const arr = getResponsiblesArray(t);
        arr.forEach(name => {
            if (name && name.trim()) counts[name] = (counts[name] || 0) + 1;
        });
    });

    const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);
    const max = sorted[0]?.[1] || 1;

    if (!sorted.length) {
        el.innerHTML = '<div style="color:#4a5568;font-size:0.7rem;padding:16px;text-align:center;">Sin tareas asignadas</div>';
        return;
    }

    el.innerHTML = sorted.map(([name, count], i) => {
        const rankClass = i === 0 ? 'td-rank-1' : i === 1 ? 'td-rank-2' : i === 2 ? 'td-rank-3' : 'td-rank-other';
        const pct = Math.round((count / max) * 100);
        const rankIcon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}`;
        const avatarHtml = buildTdAvatar(name);
        const barColor = getTdUserColor(name);

        return `<div class="td-team-row ${rankClass}">
            <span class="td-team-rank">${rankIcon}</span>
            ${avatarHtml}
            <div class="td-team-info">
                <div class="td-team-name">${esc(name.split(' ')[0])}</div>
                <div class="td-team-count">${count} tarea${count !== 1 ? 's' : ''}</div>
            </div>
            <div class="td-team-bar-wrap">
                <div class="td-team-bar-bg"><div class="td-team-bar-fill" style="width:${pct}%; background:${barColor}; box-shadow:0 0 8px ${barColor}55;"></div></div>
                <div class="td-team-pct">${pct}%</div>
            </div>
        </div>`;
    }).join('');
}

function buildTdAvatar(name) {
    const customAvatars = cachedAvatars;
    const n = name.trim().toLowerCase();
    let imgSrc = customAvatars[name] || null;
    
    if (!imgSrc) {
        if (n.includes('diego'))   imgSrc = 'team/Diego Rozo.png';
        else if (n.includes('maycol'))  imgSrc = 'team/Maycol.png';
        else if (n.includes('alex'))    imgSrc = 'team/Alex.png';
        else if (n.includes('daniela')) imgSrc = 'team/Daniel_duarte.png';
        else if (n === 'daniel angulo' || n === 'daniel') imgSrc = 'team/Daniel.png';
        else if (n.includes('camilo'))  imgSrc = 'team/Camilo Davila.png';
    }

    if (imgSrc) {
        return `<img src="${imgSrc}" class="td-team-avatar" style="cursor:pointer;" alt="${esc(name)}" ondblclick="openProfileModal('${esc(name)}')">`;
    } else {
        const initials = getInitials(name);
        const color = stringToColor(name);
        return `<div class="td-team-avatar-circle" style="background:${color}; cursor:pointer;" ondblclick="openProfileModal('${esc(name)}')">${initials}</div>`;
    }
}

// ── CATEGORY DEMAND BARS ──
function renderTdCats() {
    const el = document.getElementById('tdCatBars');
    if (!el) return;

    const counts = {};
    tasks.forEach(t => { if (t.category) counts[t.category] = (counts[t.category] || 0) + 1; });

    const allCats = Object.keys(catLabels);
    const withMovement = allCats
        .filter(c => (counts[c] || 0) > 0)
        .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
        .map(c => [c, counts[c]]);
    const noMovement = allCats
        .filter(c => !(counts[c] > 0))
        .map(c => [c, 0]);

    const sorted = [...withMovement, ...noMovement];
    const max = withMovement[0]?.[1] || 1;

    if (!sorted.length) {
        el.innerHTML = '<div style="color:#4a5568;font-size:0.7rem;padding:16px;text-align:center;">Sin datos</div>';
        return;
    }

    let html = '';
    withMovement.forEach(([cat, count], i) => {
        html += buildTdCatRow(cat, count, max, i, false);
    });
    if (noMovement.length) {
        html += `<div class="td-cat-divider">Sin movimiento — desplázate ↓</div>`;
        noMovement.forEach(([cat, count], i) => {
            html += buildTdCatRow(cat, count, max, i + withMovement.length, true);
        });
    }
    el.innerHTML = html;
}

function buildTdCatRow(cat, count, max, index, inactive) {
    const label = catLabelsShort[cat] || catLabels[cat] || cat;
    const pct = inactive ? 0 : Math.round((count / max) * 100);
    const color = inactive ? '#2d3748' : TD_NEON[index % TD_NEON.length];
    const rowClass = inactive ? 'td-cat-row td-cat-row-inactive' : 'td-cat-row';
    return `<div class="${rowClass}">
        <div class="td-cat-label-row">
            <span class="td-cat-name">${esc(label)}</span>
            <span class="td-cat-num">${count}</span>
        </div>
        <div class="td-cat-bar-bg">
            <div class="td-cat-bar-fill" style="width:${inactive ? 4 : pct}%; background:${color}; box-shadow: ${inactive ? 'none' : `0 0 6px ${color}55`};"></div>
        </div>
    </div>`;
}

// ── CLIENT LIST ──
function renderTdClients() {
    const el = document.getElementById('tdClientList');
    if (!el) return;

    const counts = {};
    tasks.forEach(t => { if (t.client) counts[t.client] = (counts[t.client]||0)+1; });
    const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);

    if (!sorted.length) {
        el.innerHTML = '<div style="color:#4a5568;font-size:0.7rem;padding:16px;text-align:center;">Sin datos</div>';
        return;
    }

    el.innerHTML = sorted.map(([client, count], i) => {
        const label = clientLabelsShort[client] || client;
        const color = TD_NEON[i % TD_NEON.length];
        return `<div class="td-client-row">
            <div class="td-client-dot" style="background:${color}; box-shadow:0 0 6px ${color}88;"></div>
            <span class="td-client-name">${esc(label)}</span>
            <span class="td-client-count">${count}</span>
        </div>`;
    }).join('');
}

// ── DONUT STATUS CHART ──
function renderTdStatus() {
    const canvas = document.getElementById('tdStatusChart');
    const legend = document.getElementById('tdStatusLegend');
    if (!canvas || !legend) return;

    const statMap = {
        'no-iniciado':  { label: 'Sin iniciar', color: '#4a5568' },
        'planificado':  { label: 'Planificado', color: '#00d4ff' },
        'ajuste-cambios-revision': { label: 'Ajuste revisión', color: '#bf5af2' },
        'en-proceso':   { label: 'En proceso',  color: '#ffcc00' },
        'completado':   { label: 'Completado',  color: '#00ff88' },
        'en-critico':   { label: 'Crítico',     color: '#ff2d55' },
    };

    const counts = {};
    tasks.forEach(t => { counts[t.status] = (counts[t.status]||0)+1; });
    const entries = Object.entries(statMap).filter(([k]) => counts[k] > 0);

    if (tdStatusChartInstance) { tdStatusChartInstance.destroy(); tdStatusChartInstance = null; }

    if (!entries.length) {
        legend.innerHTML = '<div style="color:#4a5568;font-size:0.65rem;">Sin datos</div>';
        return;
    }

    tdStatusChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: entries.map(([k,v]) => v.label),
            datasets: [{
                data: entries.map(([k]) => counts[k]),
                backgroundColor: entries.map(([k,v]) => v.color + 'cc'),
                borderColor: entries.map(([k,v]) => v.color),
                borderWidth: 2,
                borderRadius: 4,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        label: function(context) {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = Math.round((context.raw / total) * 100) + '%';
                            return context.label + ': ' + context.raw + ' (' + percentage + ')';
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        font: { size: 9 }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        drawBorder: true,
                        lineWidth: 1
                    }
                },
                y: {
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.9)',
                        font: { size: 8, weight: 'bold' }
                    },
                    grid: {
                        display: false,
                        drawBorder: true,
                        lineWidth: 1
                    }
                }
            },
            animation: { duration: 1000 }
        }
    });

    legend.innerHTML = entries.map(([k,v]) => `
        <div class="td-legend-item">
            <div class="td-legend-dot" style="background:${v.color}; box-shadow:0 0 4px ${v.color}88;"></div>
            <span class="td-legend-text">${v.label}</span>
            <span class="td-legend-val">${counts[k]}</span>
        </div>`).join('');
}

// ── PARADAS DE PROCESO CHART ──
let tdPausesChartInstance = null;

function renderTdPauses() {
    const canvas = document.getElementById('tdPausesChart');
    const legend = document.getElementById('tdPausesLegend');
    if (!canvas || !legend) return;

    const catLabels = {
        'diseño': { label: 'Diseño', color: '#00d4ff' },
        'diseno': { label: 'Diseño', color: '#00d4ff' },
        'desarrollo': { label: 'Desarrollo', color: '#ffcc00' },
        'testing': { label: 'Testing', color: '#00ff88' },
        'producción': { label: 'Producción', color: '#ff2d55' },
        'produccion': { label: 'Producción', color: '#ff2d55' },
        'marketing': { label: 'Marketing', color: '#bf5af2' },
        'serigrafia': { label: 'Serigrafía', color: '#ff6b6b' },
        'exhibicion': { label: 'Exhibición', color: '#4ecdc4' },
        'otros': { label: 'Otros', color: '#4a5568' },
    };

    const counts = {};
    const clientCounts = {};
    let totalPauses = 0;

    // Recopilar todas las paradas con información
    const allPauses = [];

    tasks.forEach(t => {
        const cat = t.category ? t.category.toLowerCase() : 'otros';
        const pauseCount = (t.pauses && t.pauses.length > 0) ? t.pauses.length : 0;
        
        if (pauseCount > 0) {
            counts[cat] = (counts[cat] || 0) + pauseCount;
            totalPauses += pauseCount;
            
            const clientName = t.client || 'Sin cliente';
            clientCounts[clientName] = (clientCounts[clientName] || 0) + pauseCount;
            
            t.pauses.forEach(p => {
                allPauses.push({
                    client: clientName,
                    task: t.name || 'Sin tarea',
                    category: cat,
                    reason: p.reason || 'Sin motivo',
                    observation: p.observation || 'Sin observación',
                    startDate: p.startDate || '',
                    endDate: p.endDate || ''
                });
            });
        }
    });

    let topClientName = null;
    let topClientCount = 0;
    Object.entries(clientCounts).forEach(([client, count]) => {
        if (count > topClientCount) {
            topClientCount = count;
            topClientName = client;
        }
    });

    // Asegurar etiquetas y colores para categorías nuevas
    Object.keys(counts).forEach((cat, index) => {
        if (!catLabels[cat]) {
            const hue = (index * 137.5) % 360;
            catLabels[cat] = { 
                label: cat.charAt(0).toUpperCase() + cat.slice(1), 
                color: `hsl(${hue}, 70%, 60%)` 
            };
        }
    });

    const entries = Object.keys(counts).map(k => [k, catLabels[k]]);

    if (tdPausesChartInstance) { tdPausesChartInstance.destroy(); tdPausesChartInstance = null; }

    if (totalPauses === 0) {
        tdPausesChartInstance = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: ['Sin Paradas'],
                datasets: [{
                    data: [100],
                    backgroundColor: ['rgba(74, 85, 104, 0.3)'],
                    borderColor: ['rgba(74, 85, 104, 0.5)'],
                    borderWidth: 2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                }
            }
        });

        legend.innerHTML = `
            <div style="text-align:center; padding:10px;">
                <div style="font-size:2rem; font-weight:700; color:#4a5568; margin-bottom:4px;">0%</div>
                <div style="font-size:0.7rem; font-weight:600; color:#4a5568; margin-bottom:8px;">NO HAY PARADAS</div>
                <div style="font-size:0.6rem; color:#718096;">HASTA EL MOMENTO</div>
            </div>
        `;
        return;
    }

    tdPausesChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: entries.map(([k,v]) => v.label),
            datasets: [{
                data: entries.map(([k]) => counts[k]),
                backgroundColor: entries.map(([k,v]) => v.color + 'cc'),
                borderColor: entries.map(([k,v]) => v.color),
                borderWidth: 2,
                borderRadius: 4,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        label: function(context) {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = Math.round((context.raw / total) * 100) + '%';
                            return context.label + ': ' + context.raw + ' paradas (' + percentage + ')';
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        font: { size: 9 }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        drawBorder: true,
                        lineWidth: 1
                    }
                },
                y: {
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.9)',
                        font: { size: 8, weight: 'bold' }
                    },
                    grid: {
                        display: false,
                        drawBorder: true,
                        lineWidth: 1
                    }
                }
            }
        }
    });

    const pausesList = allPauses.map(p => `
        <div class="td-pause-item" style="padding:6px 8px; margin-bottom:4px; background:rgba(0,0,0,0.2); border-radius:4px; border-left:3px solid ${catLabels[p.category]?.color || '#4a5568'};">
            <div style="font-size:0.65rem; font-weight:700; color:#fff; margin-bottom:2px;">${p.client}</div>
            <div style="font-size:0.6rem; color:rgba(255,255,255,0.7); margin-bottom:2px;">${p.task}</div>
            <div style="font-size:0.6rem; color:rgba(255,255,255,0.6);">${p.reason}${p.observation ? ': ' + p.observation : ''}</div>
        </div>
    `).join('');

    const topClientHtml = topClientName ? `
        <div style="background: rgba(255, 45, 85, 0.1); border: 1px solid rgba(255, 45, 85, 0.3); border-radius: 6px; padding: 8px; margin-bottom: 12px;">
            <div style="font-size: 0.55rem; color: #ff2d55; font-weight: bold; margin-bottom: 4px; letter-spacing: 0.05em;">CLIENTE CON MÁS PARADAS</div>
            <div style="font-size: 0.75rem; color: #fff; font-weight: 600;">${topClientName} <span style="color: rgba(255,255,255,0.6); font-size: 0.65rem; font-weight: 400;">(${topClientCount} paradas)</span></div>
        </div>
    ` : '';

    legend.innerHTML = `
        ${topClientHtml}
        <div style="margin-bottom:8px;">
            ${entries.map(([k,v]) => `
                <div class="td-legend-item" style="display:flex; align-items:center; margin-bottom:4px;">
                    <div class="td-legend-dot" style="background:${v.color}; box-shadow:0 0 4px ${v.color}88; width:8px; height:8px; border-radius:50%; margin-right:6px;"></div>
                    <span class="td-legend-label" style="font-size:0.65rem; color:rgba(255,255,255,0.8);">${v.label}: ${counts[k]}</span>
                </div>
            `).join('')}
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:8px; margin-top:8px; max-height:160px; overflow-y:auto;">
            <div style="font-size:0.65rem; font-weight:700; color:rgba(255,255,255,0.9); margin-bottom:6px;">DETALLE DE PARADAS</div>
            ${pausesList}
        </div>
    `;
}

// ── MAIN TREND LINE CHART — una línea por usuario (carga = movimiento) ──
function rebuildTrendData() {
    const tf = tdActiveTimeframe;
    const now = Date.now();
    const points = tf === '1h' ? 60 : tf === '1d' ? 48 : 30;
    const step = tf === '1h' ? 60000 : tf === '1d' ? 1800000 : 86400000;

    const loads = getTdResponsibleLoads();
    const names = Object.keys(loads);
    const maxLoad = Math.max(...Object.values(loads), 1);

    if (!names.length) {
        tdTrendSeries = [];
        return;
    }

    tdTrendSeries = names.map((name, idx) => {
        const load = loads[name];
        const volatility = getSeriesVolatility(load, maxLoad);
        const base = Math.max(load, 0.5);
        const color = getTdUserColor(name);

        let seed = 42 + idx * 17;
        const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

        let val = base * 0.6 + rand() * base * 0.4;
        const data = [];
        for (let i = points; i >= 0; i--) {
            const t = now - i * step;
            const jitter = (rand() - 0.5) * base * volatility * 1.15;
            const spike = Math.random() > 0.58
                ? (Math.random() - 0.5) * base * volatility * (1.6 + Math.random())
                : 0;
            const micro = (Math.random() - 0.5) * base * 0.35;
            val += jitter + spike + micro;
            val = Math.max(0.3, Math.min(base * 3.2, val));
            data.push({ x: t, y: parseFloat(val.toFixed(2)) });
        }

        return { name, color, load, volatility, data };
    });
}

function renderTdChartLegend() {
    const el = document.getElementById('tdChartLegend');
    if (!el) return;
    if (!tdTrendSeries.length) {
        el.innerHTML = '<span class="td-chart-legend-item">Sin usuarios con tareas activas</span>';
        return;
    }
    el.innerHTML = tdTrendSeries.map(s => {
        const short = esc(s.name.split(' ')[0]);
        return `<span class="td-chart-legend-item" title="${esc(s.name)} — ${s.load} tarea(s)">
            <span class="td-chart-legend-line" style="background:${s.color}; color:${s.color};"></span>
            ${short}
        </span>`;
    }).join('');
}

function renderTdTrendChart() {
    const canvas = document.getElementById('tdTrendChart');
    if (!canvas) return;

    rebuildTrendData();
    renderTdChartLegend();

    if (tdTrendChartInstance) { tdTrendChartInstance.destroy(); tdTrendChartInstance = null; }

    if (!tdTrendSeries.length) {
        const elLoad = document.getElementById('tdCurrentLoad');
        if (elLoad) elLoad.textContent = '—';
        return;
    }

    const datasets = tdTrendSeries.map(s => ({
        label: s.name,
        data: s.data,
        borderColor: s.color,
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: s.color,
        pointHoverBorderColor: '#f1f4f8',
        backgroundColor: 'transparent',
        fill: false,
        tension: getTrendLineTension(s.volatility),
    }));

    tdTrendChartInstance = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { type: 'linear', display: false },
                y: {
                    display: true,
                    grid: { color: 'rgba(255, 255, 255, 0.09)', drawBorder: false },
                    ticks: {
                        color: '#8b939f',
                        font: { family: 'JetBrains Mono', size: 9 },
                        maxTicksLimit: 5,
                        padding: 6,
                        callback: v => v.toFixed(1),
                    },
                    border: { display: false },
                },
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(42, 46, 52, 0.97)',
                    borderColor: 'rgba(255, 255, 255, 0.14)',
                    borderWidth: 1,
                    titleColor: '#a8b0bc',
                    bodyFont: { family: 'JetBrains Mono', size: 11 },
                    callbacks: {
                        labelColor: ctx => ({
                            borderColor: ctx.dataset.borderColor,
                            backgroundColor: ctx.dataset.borderColor,
                        }),
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} carga`,
                    },
                },
            },
        },
    });

    updateTrendFooter();
}

function updateTrendChart() {
    rebuildTrendData();
    renderTdChartLegend();
    if (!tdTrendChartInstance || !tdTrendSeries.length) {
        renderTdTrendChart();
        return;
    }
    tdTrendChartInstance.data.datasets = tdTrendSeries.map(s => ({
        label: s.name,
        data: s.data,
        borderColor: s.color,
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: s.color,
        backgroundColor: 'transparent',
        fill: false,
        tension: getTrendLineTension(s.volatility),
    }));
    tdTrendChartInstance.update('none');
    updateTrendFooter();
}

function updateTrendFooter() {
    if (!tdTrendSeries.length) return;

    const ranked = tdTrendSeries.map(s => ({
        name: s.name,
        vol: seriesRecentVolatility(s.data),
        last: s.data[s.data.length - 1]?.y || 0,
        color: s.color,
    })).sort((a, b) => b.vol - a.vol);

    const top = ranked[0];
    const stable = ranked[ranked.length - 1];
    const avg = (ranked.reduce((s, r) => s + r.last, 0) / ranked.length).toFixed(1);

    const elLoad = document.getElementById('tdCurrentLoad');
    const elAvg = document.getElementById('tdAvgLoad');
    const elUp = document.getElementById('tdChgUp');
    const elDown = document.getElementById('tdChgDown');

    if (elLoad) elLoad.textContent = top ? top.last.toFixed(2) : '—';
    if (elAvg) elAvg.textContent = `Promedio: ${avg}`;
    if (elUp && top) {
        elUp.textContent = `▲ ${top.name.split(' ')[0]} (más ondas)`;
        elUp.style.color = top.color;
    }
    if (elDown && stable) {
        elDown.textContent = `▼ ${stable.name.split(' ')[0]} (estable)`;
        elDown.style.color = stable.color;
    }
}

function tickTrendSeriesLive() {
    const maxPts = tdActiveTimeframe === '1h' ? 61 : tdActiveTimeframe === '1d' ? 49 : 31;
    const loads = getTdResponsibleLoads();
    const maxLoad = Math.max(...Object.values(loads), 1);

    tdTrendSeries.forEach(s => {
        const load = loads[s.name] || s.load || 1;
        s.load = load;
        s.volatility = getSeriesVolatility(load, maxLoad);
        const last = s.data[s.data.length - 1];
        if (!last) return;
        const base = Math.max(load, 0.5);
        const vol = s.volatility;
        const jitter = (Math.random() - 0.5) * base * vol * 1.35;
        const spike = Math.random() > 0.52
            ? (Math.random() - 0.5) * base * vol * (1.8 + Math.random() * 0.8)
            : 0;
        const micro = (Math.random() - 0.5) * base * 0.45;
        const pulse = Math.random() > 0.78 ? (Math.random() - 0.5) * base * 1.1 : 0;
        let newVal = last.y + jitter + spike + micro + pulse;
        newVal = Math.max(0.3, Math.min(base * 3.2, newVal));
        s.data.push({ x: Date.now(), y: parseFloat(newVal.toFixed(2)) });
        if (s.data.length > maxPts) s.data.shift();
    });
}

// ── LIVE ANIMATION ENGINE ──
function startMetricsLive() {
    if (tdLiveInterval) clearInterval(tdLiveInterval);

    tdLiveInterval = setInterval(() => {
        if (!document.getElementById('tdTrendChart')) { stopMetricsLive(); return; }
        const section = document.getElementById('viewReport');
        if (!section || !section.classList.contains('active')) return;

        if (!tdTrendSeries.length) {
            rebuildTrendData();
            if (tdTrendSeries.length) renderTdTrendChart();
            return;
        }

        tickTrendSeriesLive();

        if (tdTrendChartInstance) {
            tdTrendChartInstance.data.datasets.forEach((ds, i) => {
                if (tdTrendSeries[i]) {
                    ds.data = tdTrendSeries[i].data;
                    ds.tension = getTrendLineTension(tdTrendSeries[i].volatility);
                    ds.borderWidth = 1;
                }
            });
            tdTrendChartInstance.update('none');
        }
        updateTrendFooter();
    }, 380);
}

// ==================== PROFILE CUSTOMIZATION ====================
let currentProfileName = '';
let currentProfileBase64 = null;

function openProfileModal(name) {
    currentProfileName = name;
    currentProfileBase64 = null;
    document.getElementById('profileCurrentName').textContent = name;
    
    // Temporarily hide the double-click handler so clicking it inside the modal doesn't re-trigger
    const avatarHtml = getAvatarHtml(name, 'width: 64px; height: 64px; font-size: 1.5rem; cursor:default;').replace(/ondblclick="[^"]*"/g, '');
    document.getElementById('profileCurrentAvatar').innerHTML = avatarHtml;
    
    document.getElementById('profilePreviewWrap').style.display = 'none';
    document.getElementById('profileImagePreview').src = '';
    document.getElementById('profileUploadPlaceholder').style.display = 'flex';
    document.getElementById('profileImageInput').value = '';
    
    document.getElementById('profileModal').classList.add('open');
}

function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('open');
}

function handleProfileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(evt) {
        currentProfileBase64 = evt.target.result;
        document.getElementById('profileImagePreview').src = currentProfileBase64;
        document.getElementById('profilePreviewWrap').style.display = 'block';
        document.getElementById('profileUploadPlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
}

function saveProfile() {
    console.log('saveProfile called');
    console.log('currentProfileName:', currentProfileName);
    console.log('currentProfileBase64:', currentProfileBase64);
    
    if (currentProfileName) {
        if (currentProfileBase64) {
            saveAvatarToFirestore(currentProfileName, currentProfileBase64);
            showToast('Perfil actualizado con éxito', 'success');
        } else {
            showToast('No se cargó ninguna imagen', 'info');
        }
        
        closeProfileModal();
        // onSnapshot de avatares se encargará de re-render
    } else {
        showToast('Error: no hay nombre de perfil', 'error');
        closeProfileModal();
    }
}

// ==================== PROJECT PAUSES ====================
let pauseCounter = 0;

function addProjectPause(pauseData = null) {
    const container = document.getElementById('projectPausesContainer');
    const pauseId = pauseData ? pauseData.id : ++pauseCounter;
    
    const pauseDiv = document.createElement('div');
    pauseDiv.className = 'project-pause-item';
    pauseDiv.id = `pause-${pauseId}`;
    pauseDiv.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; margin-bottom: 8px; position: relative;';
    
    pauseDiv.innerHTML = `
        <button type="button" onclick="removeProjectPause(${pauseId})" style="position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
            <div>
                <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; display: block;">Fecha inicio de la pausa</label>
                <input type="date" class="pause-start-date" value="${pauseData ? pauseData.startDate : ''}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.9rem;">
            </div>
            <div>
                <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; display: block;">Fecha fin de la pausa</label>
                <input type="date" class="pause-end-date" value="${pauseData ? pauseData.endDate : ''}" style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.9rem;">
            </div>
        </div>
        <div style="margin-bottom: 8px;">
            <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; display: block;">Motivo de la pausa</label>
            <input type="text" class="pause-reason" value="${pauseData ? pauseData.reason : ''}" placeholder="Ej: Reunión con cliente, Tarea eventual..." style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.9rem;">
        </div>
        <div>
            <label style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 4px; display: block;">Observación (detalles adicionales)</label>
            <textarea class="pause-observation" rows="2" placeholder="Describe por qué se paró la tarea..." style="width: 100%; padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.9rem; resize: vertical;">${pauseData ? pauseData.observation : ''}</textarea>
        </div>
    `;
    
    container.appendChild(pauseDiv);
}

function removeProjectPause(pauseId) {
    const pauseElement = document.getElementById(`pause-${pauseId}`);
    if (pauseElement) {
        pauseElement.remove();
    }
}

function collectProjectPauses() {
    const container = document.getElementById('projectPausesContainer');
    const pauseItems = container.querySelectorAll('.project-pause-item');
    const pauses = [];
    
    pauseItems.forEach(item => {
        const startDate = item.querySelector('.pause-start-date').value;
        const endDate = item.querySelector('.pause-end-date').value;
        const reason = item.querySelector('.pause-reason').value.trim();
        const observation = item.querySelector('.pause-observation').value.trim();
        
        if (reason || observation) {
            pauses.push({
                id: parseInt(item.id.replace('pause-', '')),
                startDate: startDate,
                endDate: endDate,
                reason: reason,
                observation: observation
            });
        }
    });
    
    return pauses;
}

function loadProjectPauses(pauses) {
    const container = document.getElementById('projectPausesContainer');
    container.innerHTML = '';
    pauseCounter = 0;
    
    if (pauses && pauses.length > 0) {
        pauses.forEach(pause => {
            addProjectPause(pause);
        });
    }
}

// Setup pause functionality
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnAddPause').addEventListener('click', () => addProjectPause());
});

// ── MONTHLY VOLUME CHART ──
function renderTdMonthlyVolumeChart() {
    const canvas = document.getElementById('tdMonthlyVolumeChart');
    if (!canvas) return;
    
    // Forzar altura mínima en JS por si el CSS está cacheado
    if (canvas.parentElement) {
        canvas.parentElement.style.minHeight = '150px';
    }

    // Solo destruir si la instancia existe y el canvas es válido
    if (tdMonthlyVolumeChartInstance) {
        tdMonthlyVolumeChartInstance.destroy();
        tdMonthlyVolumeChartInstance = null;
    }

    // Función auxiliar para evitar saltos de zona horaria al parsear YYYY-MM-DD
    const getLocalDate = (dateStr) => {
        if (!dateStr) return null;
        const parts = dateStr.substring(0, 10).split('-');
        if (parts.length === 3) {
            return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        }
        return new Date(dateStr);
    };

    // Calculate volume by month
    const monthlyData = {};
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    
    tasks.forEach(task => {
        if (task.start) {
            const date = getLocalDate(task.start);
            if (date) {
                const monthIndex = date.getMonth();
                monthlyData[monthIndex] = (monthlyData[monthIndex] || 0) + 1;
            }
        }
    });

    const data = months.map((_, index) => monthlyData[index] || 0);

    tdMonthlyVolumeChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: months,
            datasets: [{
                label: 'Volumen de Tareas',
                data: data,
                backgroundColor: data.map((_, i) => `rgba(0, 212, 255, ${0.4 + (i * 0.05)})`),
                borderColor: 'rgba(255, 255, 255, 0.8)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 2000,
                easing: 'easeInOutQuart'
            },
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.7)',
                        font: { size: 11, weight: 'bold' }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        drawBorder: true,
                        lineWidth: 1,
                        border: {
                            display: true,
                            color: 'rgba(255, 255, 255, 0.2)',
                            width: 1
                        }
                    }
                },
                x: {
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.7)',
                        font: { size: 9, weight: 'bold' },
                        maxRotation: 45,
                        minRotation: 45
                    },
                    grid: {
                        display: true,
                        drawBorder: true,
                        lineWidth: 1,
                        color: 'rgba(255, 255, 255, 0.1)',
                        border: {
                            display: true,
                            color: 'rgba(255, 255, 255, 0.2)',
                            width: 1
                        }
                    }
                }
            }
        }
    });
}

// ── WEEKLY VOLUME CHART ──
function renderTdWeeklyVolumeChart() {
    const canvas = document.getElementById('tdWeeklyVolumeChart');
    if (!canvas) return;

    // Forzar altura mínima en JS por si el CSS está cacheado
    if (canvas.parentElement) {
        canvas.parentElement.style.minHeight = '150px';
    }

    // Solo destruir si la instancia existe y el canvas es válido
    if (tdWeeklyVolumeChartInstance) {
        tdWeeklyVolumeChartInstance.destroy();
        tdWeeklyVolumeChartInstance = null;
    }

    // Days of week labels
    const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
    
    // Generate hour labels from 7:00 am to 4:45 pm for Y axis
    const hourLabels = [];
    for (let h = 7; h <= 16; h++) {
        for (let m = 0; m < 60; m += 15) {
            if (h === 16 && m > 45) continue;
            let period = h >= 12 ? 'PM' : 'AM';
            let hour12 = h > 12 ? h - 12 : h;
            const timeStr = `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
            hourLabels.push(timeStr);
        }
    }

    // Función auxiliar para evitar saltos de zona horaria al parsear YYYY-MM-DD
    const getLocalDate = (dateStr) => {
        if (!dateStr) return null;
        const parts = dateStr.substring(0, 10).split('-');
        if (parts.length === 3) {
            return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        }
        return new Date(dateStr);
    };

    // Calculate volume by day of week (Monday to Friday only)
    const weeklyData = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    
    tasks.forEach(task => {
        if (task.start) {
            const date = getLocalDate(task.start);
            if (date) {
                const dayIndex = date.getDay();
                if (dayIndex >= 1 && dayIndex <= 5) {
                    weeklyData[dayIndex] = (weeklyData[dayIndex] || 0) + 1;
                }
            }
        }
    });

    const data = [1, 2, 3, 4, 5].map(day => weeklyData[day] || 0);
    console.log('Datos del gráfico:', data);

    tdWeeklyVolumeChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: days,
            datasets: [{
                label: 'Volumen por Día',
                data: data,
                backgroundColor: data.map((_, i) => `rgba(0, 255, 136, ${0.3 + (i * 0.08)})`),
                borderColor: 'rgba(255, 255, 255, 0.8)',
                borderWidth: 1,
                borderRadius: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 2000,
                easing: 'easeInOutQuart'
            },
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: hourLabels.length - 1,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.7)',
                        font: { size: 9, weight: 'bold' },
                        callback: function(value, index) {
                            if (value >= 0 && value < hourLabels.length) {
                                return hourLabels[Math.floor(value)];
                            }
                            return '';
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        drawBorder: true,
                        lineWidth: 1
                    }
                },
                x: {
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.7)',
                        font: { size: 10, weight: 'bold' },
                        maxRotation: 0,
                        minRotation: 0
                    },
                    grid: {
                        display: false,
                        drawBorder: true,
                        lineWidth: 1,
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// ── ANIMATED METRIC ──
function renderTdAnimatedMetric() {
    const el = document.getElementById('tdAnimatedNumber');
    if (!el) return;

    const activeTasks = tasks.filter(t => t.status === 'en-proceso').length;
    animateNumber(el, 0, activeTasks, 1000);
}

// ── SMALL METRIC ──
function renderTdSmallMetric() {
    const elValue = document.getElementById('tdEfficiencyValue');
    const elBar = document.getElementById('tdEfficiencyBar');
    if (!elValue || !elBar) return;

    // Verificar si estamos usando datos de prueba (mock data)
    const isMockData = tasks.length > 0 && tasks[0].id === 1 && tasks[0].name === 'Diseño de interfaz';
    
    let efficiency;
    if (isMockData) {
        // Valor estático para datos de prueba
        efficiency = 68;
    } else {
        // Cálculo dinámico para datos reales
        const total = tasks.length;
        const completed = tasks.filter(t => t.status === 'completado').length;
        efficiency = total ? Math.round((completed / total) * 100) : 0;
    }

    elValue.textContent = `${efficiency}%`;
    elBar.style.width = `${efficiency}%`;
}

function animateNumber(element, start, end, duration) {
    const startTime = performance.now();
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        const current = Math.floor(start + (end - start) * easeProgress);
        
        element.textContent = current;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// ── FORMATEAR FLUJO (ELIMINAR TODAS LAS TAREAS) ──
window.formatFlow = async function() {
    const password = prompt("Para formatear el flujo, por favor ingresa la contraseña de administrador:");
    if (password === "9090danielchallenger") {
        const confirmDelete = confirm("¿Estás seguro de que deseas eliminar todas las actividades y formatear el flujo? Esta acción dejará el tablero en cero y no se puede deshacer.");
        if (confirmDelete) {
            await deleteAllTasksFromFirestore();
            alert("Flujo formateado correctamente. Todas las actividades han sido eliminadas.");
        }
    } else if (password !== null) {
        alert("Contraseña incorrecta. Acción cancelada.");
    }
};


