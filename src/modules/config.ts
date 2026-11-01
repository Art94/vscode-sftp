import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import * as Joi from 'joi';
import { CONFIG_PATH } from '../constants';
import { reportError } from '../helper';
import { getUserSetting, showTextDocument } from '../host';

const nullable = schema => schema.optional().allow(null);
const blankable = schema => schema.allow('');

const configScheme = {
  name: Joi.string(),

  context: blankable(Joi.string()),
  remote: blankable(Joi.string()),
  defaultProfile: blankable(Joi.string()),
  protocol: Joi.any().valid('sftp', 'ftp', 'local'),

  host: blankable(Joi.string()).required(),
  port: Joi.number().integer(),
  connectTimeout: Joi.number().integer(),
  filePerm: nullable(Joi.number()),
  dirPerm: nullable(Joi.number()),
  username: blankable(Joi.string()).required(),
  password: nullable(blankable(Joi.string())),

  agent: nullable(blankable(Joi.string())),
  privateKeyPath: nullable(blankable(Joi.string())),
  passphrase: nullable(blankable(Joi.string().allow(true))),
  interactiveAuth: Joi.alternatives([
    Joi.boolean(),
    Joi.array()
      .items(Joi.string()),
  ]).optional(),
  algorithms: Joi.any(),
  sshConfigPath: blankable(Joi.string()),
  sshCustomParams: blankable(Joi.string()),
  hop: Joi.alternatives([
    Joi.object(),
    Joi.array().items(Joi.object()),
  ]),
  profiles: Joi.object(),

  secure: Joi.any().valid(true, false, 'control', 'implicit'),
  secureOptions: nullable(Joi.object()),
  passive: Joi.boolean(),

  remotePath: Joi.string().required(),
  uploadOnSave: Joi.boolean(),
  useTempFile: Joi.boolean(),
  openSsh: Joi.boolean(),
  downloadOnOpen: Joi.boolean().allow('confirm'),

  ignore: Joi.array()
    .min(0)
    .items(Joi.string()),
  ignoreFile: blankable(Joi.string()),
  watcher: {
    files: Joi.string().allow('', false, null),
    autoUpload: Joi.boolean(),
    autoDelete: Joi.boolean(),
  },
  concurrency: Joi.number().integer(),
  limitOpenFilesOnRemote: Joi.alternatives([
    Joi.boolean(),
    Joi.number(),
  ]),

  syncOption: {
    delete: Joi.boolean(),
    skipCreate: Joi.boolean(),
    ignoreExisting: Joi.boolean(),
    update: Joi.boolean(),
  },
  remoteTimeOffsetInHours: Joi.number(),

  remoteExplorer: {
    filesExclude: Joi.array()
      .min(0)
      .items(Joi.string()),
    order: Joi.number(),
  },
};

export const newConfigTemplate = {
  name: 'My Server',
  context: '',
  remote: '',
  defaultProfile: '',
  protocol: 'sftp',
  host: '',
  port: 22,
  username: '',
  password: '',
  remotePath: '/',
  connectTimeout: 10000,
  filePerm: null,
  dirPerm: null,
  uploadOnSave: false,
  useTempFile: false,
  openSsh: false,
  downloadOnOpen: false,
  ignore: [],
  ignoreFile: '',
  watcher: {
    files: '',
    autoUpload: false,
    autoDelete: false,
  },
  concurrency: 4,
  syncOption: {
    delete: false,
    skipCreate: false,
    ignoreExisting: false,
    update: false,
  },
  remoteTimeOffsetInHours: 0,
  remoteExplorer: {
    filesExclude: [],
    order: 0,
  },
  limitOpenFilesOnRemote: false,
  agent: '',
  privateKeyPath: '',
  passphrase: '',
  interactiveAuth: false,
  algorithms: {},
  sshConfigPath: '',
  sshCustomParams: '',
  hop: [],
  profiles: {},
  secure: false,
  secureOptions: {},
  passive: false,
};

const defaultConfig = {
  // common
  // name: undefined,
  remotePath: './',
  uploadOnSave: false,
  useTempFile: false,
  openSsh: false,
  downloadOnOpen: false,
  ignore: [],
  // ignoreFile: undefined,
  // watcher: {
  //   files: false,
  //   autoUpload: false,
  //   autoDelete: false,
  // },
  concurrency: 4,
  // limitOpenFilesOnRemote: false

  protocol: 'sftp',

  // server common
  // host,
  // port,
  // username,
  // password,
  connectTimeout: 10 * 1000,

  // sftp
  // agent,
  // privateKeyPath,
  // passphrase,
  interactiveAuth: false,
  // algorithms,

  // ftp
  secure: false,
  // secureOptions,
  // passive: false,
  remoteTimeOffsetInHours: 0,

  remoteExplorer: {
    order: 0,
  },
};

function mergedDefault(config, defaultPrivateKeyPath) {
  const merged = {
    ...defaultConfig,
    ...config,
  };

  return applyDefaultPrivateKeyPath(merged, defaultPrivateKeyPath, merged.protocol);
}

function applyDefaultPrivateKeyPath(config, defaultPath, inheritedProtocol) {
  const merged = { ...config };
  const protocol = merged.protocol || inheritedProtocol;

  if (
    protocol === 'sftp' &&
    defaultPath &&
    (merged.privateKeyPath === undefined || merged.privateKeyPath === '')
  ) {
    merged.privateKeyPath = defaultPath;
  }

  if (Array.isArray(merged.hop)) {
    merged.hop = merged.hop.map(item =>
      applyDefaultPrivateKeyPath(item, defaultPath, protocol)
    );
  } else if (merged.hop && typeof merged.hop === 'object') {
    merged.hop = applyDefaultPrivateKeyPath(merged.hop, defaultPath, protocol);
  }

  if (merged.profiles && typeof merged.profiles === 'object') {
    merged.profiles = Object.keys(merged.profiles).reduce((profiles, name) => {
      profiles[name] = applyDefaultPrivateKeyPath(
        merged.profiles[name],
        defaultPath,
        protocol
      );
      return profiles;
    }, {});
  }

  return merged;
}

function getConfigPath(basePath) {
  return path.join(basePath, CONFIG_PATH);
}

export function validateConfig(config) {
  const { error } = Joi.validate(config, configScheme, {
    allowUnknown: true,
    convert: false,
    language: {
      object: {
        child: '!!prop "{{!child}}" fails because {{reason}}',
      },
    },
  });
  return error;
}

export function readConfigsFromFile(configPath): Promise<any[]> {
  return fse.readJson(configPath).then(config => {
    const configs = Array.isArray(config) ? config : [config];
    const configUri = vscode.Uri.file(configPath);
    const defaultPrivateKeyPath = getUserSetting('sftp', configUri).get(
      'privateKeyPath',
      ''
    );
    return configs.map(item => mergedDefault(item, defaultPrivateKeyPath));
  });
}

export function tryLoadConfigs(workspace): Promise<any[]> {
  const configPath = getConfigPath(workspace);
  return fse.pathExists(configPath).then(
    exist => {
      if (exist) {
        return readConfigsFromFile(configPath);
      }
      return [];
    },
    _ => []
  );
}

// export function getConfig(activityPath: string) {
//   const config = configTrie.findPrefix(normalizePath(activityPath));
//   if (!config) {
//     throw new Error(`(${activityPath}) config file not found`);
//   }

//   return normalizeConfig(config);
// }

export function newConfig(basePath) {
  const configPath = getConfigPath(basePath);

  return fse
    .pathExists(configPath)
    .then(exist => {
      if (exist) {
        return showTextDocument(vscode.Uri.file(configPath));
      }

      const defaultPrivateKeyPath = getUserSetting(
        'sftp',
        vscode.Uri.file(basePath)
      ).get('privateKeyPath', '');
      const config = {
        ...newConfigTemplate,
        privateKeyPath: defaultPrivateKeyPath,
      };

      return fse
        .outputJson(
          configPath,
          config,
          { spaces: 4 }
        )
        .then(() => showTextDocument(vscode.Uri.file(configPath)));
    })
    .catch(reportError);
}
