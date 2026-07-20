module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  collectCoverageFrom: [
    "detectors/**/*.ts",
    "lock/**/*.ts",
    "monitors/**/*.ts",
    "github/**/*.ts",
    "subscribers/**/*.ts",
    "engine.ts",
  ],
  coverageThreshold: {
    "./detectors/": {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    "./lock/": {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
