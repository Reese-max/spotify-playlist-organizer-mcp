from pathlib import Path
import hashlib, json, os, re, stat, subprocess

ROLE=os.environ['QA_SUT_ROLE']; COMMIT=os.environ['QA_SUT_COMMIT']
assert ROLE in ('baseline','candidate')
assert re.fullmatch(r'[0-9a-f]{40}',COMMIT) and COMMIT!='0'*40
SOURCE=Path('sut').absolute()
AUTH=json.loads(Path('controller/sut-role-maps.json').read_text(encoding='utf-8'))['roles'][ROLE]
def git(*args):
    return subprocess.run(['git','-C',str(SOURCE),*args],check=True,capture_output=True,text=True).stdout.strip()
assert git('rev-parse','HEAD')==COMMIT
assert git('rev-parse','HEAD^{tree}')==AUTH['tree']
expected={x['path']:x for x in AUTH['rows']}; actual=set()
for directory,dirs,files in os.walk(SOURCE,followlinks=False):
    base=Path(directory)
    if base==SOURCE: dirs[:]=[d for d in dirs if d not in ('.git','node_modules')]
    for d in dirs:
        s=(base/d).lstat(); assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
    for name in files:
        p=base/name; rel=p.relative_to(SOURCE).as_posix(); actual.add(rel)
assert actual==set(expected)
for rel,row in expected.items():
    p=SOURCE/rel; s=p.lstat(); assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode)
    b=p.read_bytes(); assert len(b)==row['size']
    assert hashlib.sha256(b).hexdigest()==row['sha256']
    assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==row['sha']
    assert row['mode']=='100644' and not (s.st_mode & 0o111)
print(json.dumps({'status':'EXACT_71_SUT_TRACKED_SOURCE','role':ROLE,'commit':COMMIT,'tree':AUTH['tree'],'files':71,'dependencyReadinessClaim':False}))
