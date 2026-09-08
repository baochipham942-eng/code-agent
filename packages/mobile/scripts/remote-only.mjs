if (!process.env.SSH_CONNECTION && process.env.CI !== 'true') {
  throw new Error('REMOTE_BUILD_REQUIRED: run mobile dependencies, builds and tests on the assigned runner');
}
