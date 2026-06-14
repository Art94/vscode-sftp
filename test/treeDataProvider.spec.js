/**
 * Тест: Cannot resolve tree item в Remote Explorer.
 * 
 * Корень бага: refreshRemoteExplorer создаёт новый объект item не из кэша _map.
 * refresh() → fire(parent) → getChildren(parent) ищет item в кэше, но find
 * возвращает СТАРЫЙ объект, а reveal пытается показать НОВЫЙ → identity mismatch.
 * 
 * Фикс: в refresh() всегда перезаписывать кэш _map актуальным объектом.
 */

const upath = require('upath');
const querystring = require('querystring');

function createUriString(authority, filepath, query) {
  const n = encodeURIComponent(filepath.replace(/^\/+/, ''));
  const qs = encodeURIComponent(querystring.stringify(query));
  return `remote://${authority}/${n}?${qs}`;
}

const FakeUri = {
  parse: (s) => {
    const [scheme, rest] = s.split('://');
    const [authority, ...pathParts] = rest.split('/');
    const pq = pathParts.join('/');
    const idx = pq.indexOf('?');
    const path = idx >= 0 ? '/' + decodeURIComponent(pq.substring(0, idx)) : '/' + decodeURIComponent(pq);
    const query = idx >= 0 ? pq.substring(idx + 1) : '';
    return { scheme, authority, path, query, fsPath: undefined };
  },
};

class FakeResource {
  constructor(uri) {
    this._uri = uri;
    if (uri.scheme === 'remote') {
      const q = querystring.parse(decodeURIComponent(uri.query));
      this._remoteId = parseInt(q.remoteId, 10);
      this._fsPath = q.fsPath;
    } else { this._fsPath = uri.fsPath; }
  }
  get remoteId() { return this._remoteId; }
  get uri() { return this._uri; }
  get fsPath() { return this._fsPath; }
}

function makeResource(config) {
  if (!config.remote) return new FakeResource(FakeUri.file(config.fsPath));
  const { host, port } = config.remote;
  const authority = `${host}${port ? ':' + port : ''}`;
  return new FakeResource(FakeUri.parse(createUriString(authority, config.fsPath, { remoteId: config.remoteId, fsPath: config.fsPath })));
}

function updateResource(resource, delta) {
  const query = querystring.parse(decodeURIComponent(resource.uri.query));
  query.fsPath = delta.remotePath;
  return new FakeResource(FakeUri.parse(createUriString(resource.uri.authority, delta.remotePath, query)));
}

const ROOT_PATH = '/var/www/html/wp-content/themes/prizovita-theme';

function createProvider(mockFileSystem) {
  const root = {
    resource: makeResource({ remote: { host: '85.239.49.124', port: 22 }, fsPath: ROOT_PATH, remoteId: 1 }),
    isDirectory: true,
    explorerContext: { fileService: { name: 'new configuration', id: 1 }, config: { remoteExplorer: { filesExclude: [], order: 0 }, ignore: [] }, id: 1 },
  };

  const map = new Map();
  map.set(root.resource.uri.query, root);

  function getChildren(item) {
    const files = mockFileSystem[item.resource.fsPath] || [];
    return files.map(f => {
      const r = updateResource(item.resource, { remotePath: f.fspath });
      const key = r.uri.query;
      if (map.has(key)) return map.get(key);
      const child = { resource: r, isDirectory: f.type === 0 };
      map.set(key, child);
      return child;
    });
  }

  function getParent(element) {
    if (element.resource.fsPath === root.resource.fsPath) return root;
    const parentPath = upath.dirname(element.resource.fsPath);
    const pq = updateResource(element.resource, { remotePath: parentPath }).uri.query;
    const cached = map.get(pq);
    if (cached) return cached;
    const p = { resource: updateResource(element.resource, { remotePath: parentPath }), isDirectory: true };
    map.set(p.resource.uri.query, p);
    return p;
  }

  // refresh с фиксом: всегда map.set
  function refresh(item) {
    if (!item) { map.clear(); return; }
    if (item.isDirectory) return;
    map.set(item.resource.uri.query, item);
    const parent = getParent(item);
    // fire(parent) в реальном коде перезагружает getChildren(parent);
    // здесь эмулируем вызовом getChildren для проверки
    if (parent) getChildren(parent);
  }

  return { root, getChildren, getParent, map, refresh };
}

describe('Remote Explorer tree resolve', () => {
  const mockFs = {};
  beforeAll(() => {
    mockFs[ROOT_PATH] = [{ fspath: `${ROOT_PATH}/project`, type: 0 }];
    mockFs[`${ROOT_PATH}/project`] = [{ fspath: `${ROOT_PATH}/project/features`, type: 0 }];
    mockFs[`${ROOT_PATH}/project/features`] = [{ fspath: `${ROOT_PATH}/project/features/main-page`, type: 0 }];
    mockFs[`${ROOT_PATH}/project/features/main-page`] = [
      { fspath: `${ROOT_PATH}/project/features/main-page/bootstrap.php`, type: 1 },
      { fspath: `${ROOT_PATH}/project/features/main-page/main-page.css`, type: 1 },
    ];
  });

  it('раскрытие дерева до bootstrap.php', () => {
    const { root, getChildren } = createProvider(mockFs);
    const project = getChildren(root)[0];
    expect(project.resource.fsPath).toBe(`${ROOT_PATH}/project`);
    const features = getChildren(project)[0];
    expect(features.resource.fsPath).toBe(`${ROOT_PATH}/project/features`);
    const mainPage = getChildren(features)[0];
    expect(mainPage.resource.fsPath).toBe(`${ROOT_PATH}/project/features/main-page`);
    const files = getChildren(mainPage);
    expect(files.length).toBe(2);
  });

  it('getParent цепочка от файла до корня', () => {
    const { root, getChildren, getParent } = createProvider(mockFs);
    const project = getChildren(root)[0];
    const features = getChildren(project)[0];
    const mainPage = getChildren(features)[0];
    const files = getChildren(mainPage);
    const bootstrap = files[0];

    expect(getParent(bootstrap).resource.fsPath).toBe(mainPage.resource.fsPath);
    expect(getParent(mainPage).resource.fsPath).toBe(features.resource.fsPath);
    expect(getParent(features).resource.fsPath).toBe(project.resource.fsPath);
    expect(getParent(project).resource.fsPath).toBe(root.resource.fsPath);
  });

  it('новый item из refreshRemoteExplorer сохраняется в кэш и находится в дереве', () => {
    const { root, getChildren, getParent, refresh } = createProvider(mockFs);
    // Предзагружаем дерево (как если бы пользователь раскрыл папки)
    getChildren(root);
    const project = getChildren(root)[0];
    getChildren(project);
    const features = getChildren(project)[0];
    getChildren(features);
    const mainPage = getChildren(features)[0];
    getChildren(mainPage);

    // refreshRemoteExplorer создаёт новый объект (не из кэша)
    const freshItem = {
      resource: makeResource({
        remote: { host: '85.239.49.124', port: 22 },
        fsPath: `${ROOT_PATH}/project/features/main-page/bootstrap.php`,
        remoteId: 1,
      }),
      isDirectory: false,
    };

    // refresh с фиксом: map.set перезаписывает старый объект новым
    refresh(freshItem);

    // getChildren должен вернуть свежий объект
    const filesAfter = getChildren(mainPage);
    const found = filesAfter.find(f => f.resource.uri.query === freshItem.resource.uri.query);
    expect(found).toBeDefined();
    expect(found).toBe(freshItem);
  });

  it('VS Code resolve цепочка от свежего item до корня', () => {
    const { root, getChildren, getParent, refresh } = createProvider(mockFs);
    getChildren(root);
    getChildren(getChildren(root)[0]);
    getChildren(getChildren(getChildren(root)[0])[0]);
    getChildren(getChildren(getChildren(getChildren(root)[0])[0])[0]);

    const freshItem = {
      resource: makeResource({
        remote: { host: '85.239.49.124', port: 22 },
        fsPath: `${ROOT_PATH}/project/features/main-page/bootstrap.php`,
        remoteId: 1,
      }),
      isDirectory: false,
    };

    refresh(freshItem);

    let current = freshItem;
    const chain = [];
    while (true) {
      chain.push(current.resource.fsPath);
      const p = getParent(current);
      if (!p || p.resource.fsPath === current.resource.fsPath) break;
      const siblings = getChildren(p);
      expect(siblings.some(s => s === current)).toBe(true);
      current = p;
    }
    expect(chain.length).toBe(5);
    expect(chain[0]).toContain('bootstrap.php');
  });
});
