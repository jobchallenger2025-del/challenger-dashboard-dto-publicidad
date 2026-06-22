const { JSDOM } = require('jsdom');
const dom = new JSDOM(`
    <!DOCTYPE html>
    <body>
        <canvas id="tdMonthlyVolumeChart"></canvas>
        <canvas id="tdWeeklyVolumeChart"></canvas>
    </body>
`);
global.window = dom.window;
global.document = dom.window.document;
global.performance = { now: () => 0 };

global.Chart = require('chart.js/auto');

const tasks = [
    { start: '2024-06-19T08:00:00.000Z' },
    { start: '2024-06-18T08:00:00.000Z' }
];
let tdMonthlyVolumeChartInstance = null;
let tdWeeklyVolumeChartInstance = null;

function renderTdMonthlyVolumeChart() {
    const canvas = document.getElementById('tdMonthlyVolumeChart');
    if (!canvas) return;

    if (tdMonthlyVolumeChartInstance) {
        tdMonthlyVolumeChartInstance.destroy();
        tdMonthlyVolumeChartInstance = null;
    }

    const monthlyData = {};
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    
    tasks.forEach(task => {
        if (task.start) {
            const date = new Date(task.start);
            const monthIndex = date.getMonth();
            monthlyData[monthIndex] = (monthlyData[monthIndex] || 0) + 1;
        }
    });

    const data = months.map((_, index) => monthlyData[index] || 0);

    try {
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
        console.log("Monthly chart rendered successfully.");
    } catch (e) {
        console.error("Error rendering Monthly chart:", e);
    }
}

function renderTdWeeklyVolumeChart() {
    const canvas = document.getElementById('tdWeeklyVolumeChart');
    if (!canvas) return;

    if (tdWeeklyVolumeChartInstance) {
        tdWeeklyVolumeChartInstance.destroy();
        tdWeeklyVolumeChartInstance = null;
    }

    const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
    const weeklyData = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    
    tasks.forEach(task => {
        if (task.start) {
            const date = new Date(task.start);
            const dayIndex = date.getDay();
            if (dayIndex >= 1 && dayIndex <= 5) {
                weeklyData[dayIndex] = (weeklyData[dayIndex] || 0) + 1;
            }
        }
    });

    const data = [1, 2, 3, 4, 5].map(day => weeklyData[day] || 0);

    try {
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
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)',
                            font: { size: 10, weight: 'bold' }
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
        console.log("Weekly chart rendered successfully.");
    } catch (e) {
        console.error("Error rendering Weekly chart:", e);
    }
}

renderTdMonthlyVolumeChart();
renderTdWeeklyVolumeChart();

