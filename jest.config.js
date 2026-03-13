/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "jsdom",
  testMatch: [
    "**/tests/unit/**/*.test.js",
    "**/tests/property/**/*.prop.js"
  ],
  clearMocks: true
};
