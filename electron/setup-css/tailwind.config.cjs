/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['../setup.html'],
  plugins: [require('daisyui')],
  daisyui: {
    themes: ['corporate'],
    logs: false,
  },
};
