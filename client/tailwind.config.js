/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      borderRadius: {
        lg: '0.5rem',
        md: 'calc(0.5rem - 2px)',
        sm: 'calc(0.5rem - 4px)',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        light: {
          primary: '#3b82f6',
          'primary-content': '#f8fafc',
          secondary: '#e2e8f0',
          'secondary-content': '#1e293b',
          accent: '#e2e8f0',
          'accent-content': '#1e293b',
          neutral: '#334155',
          'neutral-content': '#f8fafc',
          'base-100': '#ffffff',
          'base-200': '#f1f5f9',
          'base-300': '#e2e8f0',
          'base-content': '#0f172a',
          info: '#3b82f6',
          'info-content': '#ffffff',
          success: '#22c55e',
          'success-content': '#ffffff',
          warning: '#f59e0b',
          'warning-content': '#ffffff',
          error: '#ef4444',
          'error-content': '#ffffff',
        },
      },
    ],
    logs: false,
  },
};
