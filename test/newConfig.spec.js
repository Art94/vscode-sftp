jest.mock('vscode', () => ({
  Uri: {
    file: jest.fn(path => ({ fsPath: path })),
  },
}));
jest.mock('fs-extra', () => ({
  outputJson: jest.fn(),
  pathExists: jest.fn(),
  readJson: jest.fn(),
}));
jest.mock('../src/helper', () => ({
  reportError: jest.fn(),
}));
jest.mock('../src/host', () => ({
  getUserSetting: jest.fn(),
  showTextDocument: jest.fn(),
}));

const path = require('path');
const fse = require('fs-extra');
const vscode = require('vscode');
const { getUserSetting, showTextDocument } = require('../src/host');
const {
  newConfig,
  newConfigTemplate,
  readConfigsFromFile,
  validateConfig,
} = require('../src/modules/config');

const settings = { privateKeyPath: '' };

describe('new SFTP config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fse.pathExists.mockResolvedValue(false);
    fse.outputJson.mockResolvedValue(undefined);
    fse.readJson.mockResolvedValue({});
    getUserSetting.mockReturnValue({
      get: jest.fn((key, fallback) => settings[key] || fallback),
    });
    showTextDocument.mockResolvedValue(undefined);
    settings.privateKeyPath = '';
  });

  test('creates and opens a complete template', async () => {
    await newConfig('/workspace');

    const configPath = path.join('/workspace', '.vscode', 'sftp.json');
    expect(fse.outputJson).toHaveBeenCalledWith(
      configPath,
      newConfigTemplate,
      { spaces: 4 }
    );
    expect(vscode.Uri.file).toHaveBeenCalledWith(configPath);
    expect(showTextDocument).toHaveBeenCalled();
    expect(validateConfig(newConfigTemplate)).toBeNull();
  });

  test('writes the configured default private key path into a new config', async () => {
    settings.privateKeyPath = '~/.ssh/id_rsa';

    await newConfig('/workspace');

    const configPath = path.join('/workspace', '.vscode', 'sftp.json');
    expect(fse.outputJson).toHaveBeenCalledWith(
      configPath,
      expect.objectContaining({ privateKeyPath: '~/.ssh/id_rsa' }),
      { spaces: 4 }
    );
    expect(newConfigTemplate.privateKeyPath).toBe('');
  });

  test('template includes connection, sync, SFTP, FTP, profiles, and hopping options', () => {
    expect(newConfigTemplate).toEqual(expect.objectContaining({
      host: '',
      username: '',
      password: '',
      remotePath: '/',
      watcher: expect.objectContaining({
        files: '',
        autoUpload: false,
        autoDelete: false,
      }),
      syncOption: expect.objectContaining({
        delete: false,
        skipCreate: false,
        ignoreExisting: false,
        update: false,
      }),
      algorithms: {},
      profiles: {},
      hop: [],
      secureOptions: {},
      passive: false,
    }));
  });

  test('uses the setting when an SFTP config leaves the key path empty', async () => {
    settings.privateKeyPath = '~/.ssh/id_rsa';
    fse.readJson.mockResolvedValue({
      protocol: 'sftp',
      privateKeyPath: '',
    });

    const [config] = await readConfigsFromFile('/workspace/.vscode/sftp.json');

    expect(config.privateKeyPath).toBe('~/.ssh/id_rsa');
    expect(getUserSetting).toHaveBeenCalledWith(
      'sftp',
      vscode.Uri.file('/workspace/.vscode/sftp.json')
    );
  });

  test('uses the setting for profiles and hops, but preserves explicit paths', async () => {
    settings.privateKeyPath = '~/.ssh/default_key';
    fse.readJson.mockResolvedValue({
      protocol: 'sftp',
      privateKeyPath: '/keys/main',
      profiles: {
        default: { privateKeyPath: '' },
        alternate: { privateKeyPath: '/keys/alternate' },
      },
      hop: [
        { host: 'jump.example.com' },
        { host: 'gateway.example.com', privateKeyPath: '' },
      ],
    });

    const [config] = await readConfigsFromFile('/workspace/.vscode/sftp.json');

    expect(config.privateKeyPath).toBe('/keys/main');
    expect(config.profiles.default.privateKeyPath).toBe('~/.ssh/default_key');
    expect(config.profiles.alternate.privateKeyPath).toBe('/keys/alternate');
    expect(config.hop[0].privateKeyPath).toBe('~/.ssh/default_key');
    expect(config.hop[1].privateKeyPath).toBe('~/.ssh/default_key');
  });
});
