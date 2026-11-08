#!/usr/bin/env python3
"""Rebuild the original, silent basketball teaching illustrations (Pillow + FFmpeg).
No models, API keys, network calls, photos, music, or downloaded assets are used.
Run from any directory: python scripts/starter-guide/generate.py
"""
import math
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'starter-guide'
W, H, FPS, SECONDS = 960, 540, 24, 4
OUT.mkdir(parents=True, exist_ok=True)

def scene():
    im = Image.new('RGB', (W,H))
    d = ImageDraw.Draw(im)
    for y in range(H):
        t=y/H
        d.line((0,y,W,y), fill=(int(27+38*t),int(42+27*t),int(67+18*t)))
    # Sunset and distant indoor-court windows.
    for x in range(40,930,150):
        d.rounded_rectangle((x,45,x+115,235),8,fill='#3c536b')
        d.rectangle((x+5,50,x+110,165),fill='#f1b984')
        d.line((x+57,45,x+57,235),fill='#213345',width=8)
    d.polygon([(0,315),(960,315),(960,540),(0,540)],fill='#b68459')
    for y in range(330,540,25):d.line((0,y,W,y),fill='#bc916c',width=2)
    for x in range(-200,1200,120):d.line((480+(x-480)*.5,315,x,540),fill='#966a49',width=2)
    d.ellipse((190,360,780,630),outline='#f4ddae',width=4)
    d.line((470,315,470,540),fill='#f4ddae',width=3)
    d.polygon([(700,325),(875,325),(950,480),(665,480)],outline='#f4ddae',width=4)
    d.line((875,160,875,365),fill='#25394c',width=12)
    d.rectangle((785,140,895,205),fill='#e8e9dd',outline='#25394c',width=5)
    d.rectangle((818,166,860,195),outline='#cc674b',width=3)
    d.ellipse((807,197,861,211),outline='#ed8048',width=6)
    for x in (811,821,833,845,857):d.line((x,207,833+(x-833)*.65,247),fill='#eae1d1',width=2)
    d.line((819,247,848,247),fill='#eae1d1',width=2)
    return im,d

def ball(d,x,y,r=15):
    d.ellipse((x-r,y-r,x+r,y+r),fill='#f49b40',outline='#783f2c',width=2)
    d.arc((x-r*.6,y-r,x+r*.6,y+r),80,280,fill='#783f2c',width=2)
    d.line((x-r,y,x+r,y),fill='#783f2c',width=2)
    d.line((x,y-r,x,y+r),fill='#783f2c',width=2)

def player(d,x,y,pose='stand',s=1):
    # y = shoe position; authored flat illustration of an older amateur player.
    def pt(a,b):return (x+a*s,y+b*s)
    def line(points,fill,width):d.line([pt(*p) for p in points],fill=fill,width=max(1,int(width*s)))
    d.ellipse((x-55*s,y-7*s,x+60*s,y+9*s),fill='#8b694f')
    hip=(-3,-72)
    line([(-10,-74),(-24,-35),(-28,-6)],'#dca47f',15)
    line([(12,-74),(29,-39),(34,-6)],'#dca47f',15)
    line([(-27,-5),(-44,-3)],'#e8ece9',11);line([(34,-5),(51,-3)],'#e8ece9',11)
    d.polygon([pt(-27,-92),pt(27,-92),pt(23,-58),pt(1,-58),pt(-3,-71),pt(-9,-58),pt(-29,-58)],fill='#223b56')
    d.polygon([pt(-22,-146),pt(18,-146),pt(30,-88),pt(-28,-88)],fill='#e9b349')
    line([(-16,-140),(-11,-96)],'#f6d785',4)
    # Number seven drawn as vector strokes, no font dependency.
    line([(-6,-127),(9,-127),(-1,-106)],'#263b52',4)
    neck=(0,-151)
    line([(0,-150),(0,-161)],'#dca47f',15)
    d.ellipse((*pt(-17,-190),*pt(17,-155)),fill='#dca47f')
    d.pieslice((*pt(-18,-193),*pt(18,-163)),180,350,fill='#c2c3bc')
    d.ellipse((*pt(8,-176),*pt(11,-173)),fill='#25394c')
    if pose=='tired':
        line([(-21,-139),(-44,-107),(-19,-77)],'#dca47f',12)
        line([(20,-139),(42,-106),(18,-77)],'#dca47f',12)
    elif pose=='shoot':
        line([(-20,-139),(-13,-178),(17,-207)],'#dca47f',12)
        line([(20,-139),(38,-174),(29,-211)],'#dca47f',12)
        line([(29,-211),(43,-211)],'#dca47f',6)
    else:
        line([(-20,-139),(-40,-107),(-7,-105)],'#dca47f',12)
        line([(20,-139),(40,-108),(9,-105)],'#dca47f',12)

def frame(shot,t,alternative=False):
    im,d=scene()
    if shot==1:
        player(d,355,450+2*math.sin(t*math.pi*4),'tired',1.25)
        ball(d,435,432,19)
        # Benches, towel and bottle establish the pause before trying again.
        d.rounded_rectangle((70,390,240,407),5,fill='#30495c')
        d.line((85,407,85,452),fill='#203448',width=8);d.line((220,407,220,452),fill='#203448',width=8)
        d.rectangle((103,379,160,395),fill='#dce5e3')
        d.rounded_rectangle((190,362,202,390),3,fill='#84bdc0')
    elif shot==2:
        player(d,395 if not alternative else 445,460,'stand',1.4 if not alternative else 1.1)
        ball(d,(395 if not alternative else 445)+2,460-105*(1.4 if not alternative else 1.1),20)
        # Focus rings are editorial overlays, not a generated model effect.
        for r in (29,40):
            d.arc((817-r,201-r,817+r,201+r),205,330,fill='#f7d67b',width=2)
    else:
        jump=18*math.sin(min(t*2,1)*math.pi)
        player(d,420,460-jump,'shoot',1.2)
        p=max(0,min(1,(t-.1)/.63))
        bx=456+(834-456)*p
        by=205+(205-205)*p-128*math.sin(p*math.pi)
        if t>.73:bx=834;by=205+min((t-.73)/.27,1)*190
        ball(d,bx,by,16)
        if t>.8:
            for k in range(8):
                a=k*math.pi/4
                d.line((834+35*math.cos(a),205+35*math.sin(a),834+48*math.cos(a),205+48*math.sin(a)),fill='#f8d77e',width=3)
    return im

for shot in (1,2,3):
    path=OUT/f'shot-{shot}.mp4'
    proc=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','pipe:0','-an','-c:v','libx264','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',str(path)],stdin=subprocess.PIPE)
    for i in range(FPS*SECONDS):proc.stdin.write(frame(shot,i/(FPS*SECONDS-1)).tobytes())
    proc.stdin.close()
    if proc.wait():raise RuntimeError(f'FFmpeg failed: {path}')
    frame(shot,.3).save(OUT/f'shot-{shot}.png',optimize=True)
frame(2,.3,True).save(OUT/'shot-2-alternative.png',optimize=True)
frame(2,.3).save(OUT/'character-reference.png',optimize=True)
scene()[0].save(OUT/'court-reference.png',optimize=True)
print(OUT)
# Reference cut is for preview only. User exports must render their edited timeline.
listing=OUT/'concat.txt'
listing.write_text(''.join(f"file 'shot-{i}.mp4'\n" for i in (1,2,3)))
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(listing),'-c','copy','-movflags','+faststart',str(OUT/'reference-cut.mp4')],check=True)
listing.unlink()
# Keep provenance checksums in sync after every rebuild.
import hashlib
import json
assets={f.name:{'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size,'provenance':'authored-vector-illustration','license':'Apache-2.0'} for f in sorted(OUT.iterdir()) if f.suffix in ('.mp4','.png')}
(OUT/'manifest.json').write_text(json.dumps({'schemaVersion':1,'created':'2026-11-08','authoring':'AI-assisted original Python vector drawing; no model inference','thirdPartyMedia':False,'audio':False,'assets':assets},indent=2)+'\n')
