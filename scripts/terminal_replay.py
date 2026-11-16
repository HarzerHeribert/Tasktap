"""Bounded private replay checkpoints with the grid at each output boundary."""
import base64
import json
import os
from pathlib import Path
import tempfile

LIMIT=2*1024*1024


class Replay:
    def __init__(self,path):
        self.path=Path(path);self.data=b'';self.sizes=[];self.sequence=0;self.created=None
        try:
            if self.path.stat().st_size>4*1024*1024:return
            value=json.loads(self.path.read_text());data=base64.b64decode(value['data'],validate=True)
            sizes=value['geometry']
            if len(data)>LIMIT or not sizes or len(sizes)>2048 or sizes[0]['offset']!=0:return
            if any(any(type(s[k]) is not int for k in ('offset','cols','rows')) for s in sizes):return
            if any(not (0<=s['offset']<=len(data) and 10<=s['cols']<=500 and 2<=s['rows']<=500) for s in sizes):return
            if sizes!=sorted(sizes,key=lambda s:s['offset']):return
            if type(value.get('seq',0)) is not int or value.get('seq',0)<0:return
            self.data=data;self.sizes=sizes;self.sequence=value.get('seq',0);self.created=value.get('created')
        except (OSError,ValueError,KeyError,TypeError):pass

    def cut(self,count):
        active=self.sizes[0]
        for size in self.sizes:
            if size['offset']<=count:active=size
        self.sizes=[dict(active,offset=0)]+[dict(s,offset=s['offset']-count) for s in self.sizes if s['offset']>count]
        self.data=self.data[count:]

    def append(self,data,sequence):
        if not self.sizes or sequence<=self.sequence:return
        self.data+=data;self.sequence=sequence
        if len(self.data)>LIMIT:
            start=len(self.data)-LIMIT;boundary=self.data.find(b'\n',start)
            self.cut(boundary+1 if boundary>=0 else start)

    def reconcile(self,data,cols,rows,sequence,created=None):
        if self.created is not None and self.created!=created:self.data=b'';self.sizes=[]
        self.created=created
        old=self.data;shift=None
        if self.sizes and data.startswith(old):shift=0
        elif self.sizes and data:
            anchor=data[:min(4096,len(data))];at=old.find(anchor,max(0,len(old)-len(data)))
            for _ in range(64):
                if at<0:break
                if data.startswith(old[at:]):shift=at;break
                at=old.find(anchor,at+1)
        if shift is None:self.sizes=[dict(offset=0,cols=cols,rows=rows)]
        elif shift:self.cut(shift)
        self.data=data;self.sequence=sequence

    def resize(self,cols,rows):
        if not self.sizes:return
        item=dict(offset=len(self.data),cols=cols,rows=rows)
        if self.sizes[-1]['offset']==item['offset']:self.sizes[-1]=item
        elif (self.sizes[-1]['cols'],self.sizes[-1]['rows'])!=(cols,rows):self.sizes.append(item)
        if len(self.sizes)>2048:self.cut(self.sizes[-2048]['offset'])
        self.save()

    def save(self):
        if not self.sizes:return
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with tempfile.NamedTemporaryFile('w',dir=self.path.parent,delete=False) as out:
            os.chmod(out.name,0o600)
            json.dump(dict(data=base64.b64encode(self.data).decode(),geometry=self.sizes,seq=self.sequence,created=self.created),out)
        os.replace(out.name,self.path)
