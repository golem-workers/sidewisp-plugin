#!/usr/bin/env python3
"""Deterministic source package admitted by OpenClaw's strict tar reader.

Git archive emits a global PAX comment even when members fit USTAR. Do not
weaken the installer: retain Git object identity in external JSON instead.
"""
import argparse,gzip,hashlib,io,json,pathlib,subprocess,tarfile

def pack_source(repository,ref,output):
    commit=subprocess.check_output(['git','-C',str(repository),'rev-parse',ref+'^{commit}'],text=True).strip()
    original=subprocess.check_output(['git','-C',str(repository),'archive','--format=tar','--prefix=package/',commit])
    plain=io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(original),mode='r:') as source,tarfile.open(fileobj=plain,mode='w:',format=tarfile.USTAR_FORMAT) as target:
        for member in source:
            if not(member.isfile() or member.isdir()):
                raise ValueError('source archive must contain only regular files and directories')
            clean=tarfile.TarInfo(member.name)
            clean.type=member.type;clean.mode=member.mode;clean.size=member.size;clean.mtime=member.mtime
            clean.uid=clean.gid=0;clean.uname=clean.gname=''
            target.addfile(clean,source.extractfile(member) if member.isfile() else None)
    data=gzip.compress(plain.getvalue(),mtime=0)
    with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as check:
        if check.pax_headers or any(m.pax_headers for m in check):
            raise ValueError('PAX metadata is not supported by the installer')
    output.write_bytes(data)
    return {'commit':commit,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'format':'ustar+gzip','globalPaxHeaders':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--ref',default='HEAD');parser.add_argument('--output',required=True,type=pathlib.Path);args=parser.parse_args()
    print(json.dumps(pack_source(pathlib.Path(__file__).resolve().parents[1],args.ref,args.output)))
