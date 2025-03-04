define(['./teletext', './utils'], function (Teletext, utils) {
    "use strict";
    const VDISPENABLE = 1 << 0,
        HDISPENABLE = 1 << 1,
        SKEWDISPENABLE = 1 << 2,
        SCANLINEDISPENABLE = 1 << 3,
        USERDISPENABLE = 1 << 4,
        FRAMESKIPENABLE = 1 << 5,
        EVERYTHINGENABLED = VDISPENABLE | HDISPENABLE | SKEWDISPENABLE | SCANLINEDISPENABLE | USERDISPENABLE | FRAMESKIPENABLE;

    function Video(isMaster, fb32_param, paint_ext_param) {
        this.isMaster = isMaster;
        this.fb32 = utils.makeFast32(fb32_param);
        this.collook = utils.makeFast32(new Uint32Array([
            0xff000000, 0xff0000ff, 0xff00ff00, 0xff00ffff,
            0xffff0000, 0xffff00ff, 0xffffff00, 0xffffffff]));
        this.screenAddrAdd = new Uint16Array([0x4000, 0x3000, 0x6000, 0x5800]);
        this.cursorTable = new Uint8Array([0x00, 0x00, 0x00, 0x80, 0x40, 0x20, 0x20]);
        this.cursorFlashMask = new Uint8Array([0x00, 0x00, 0x08, 0x10]);
        this.regs = new Uint8Array(32);
        this.bitmapX = 0;
        this.bitmapY = 0;
        this.oddClock = false;
        this.frameCount = 0;
        this.firstScanline = true;
        this.inHSync = false;
        this.inVSync = false;
        this.hadVSyncThisRow = false;
        this.checkVertAdjust = false;
        this.endOfMainLatched = false;
        this.endOfVertAdjustLatched = false;
        this.endOfFrameLatched = false;
        this.inVertAdjust = false;
        this.inDummyRaster = false;
        this.hpulseWidth = 0;
        this.vpulseWidth = 0;
        this.hpulseCounter = 0;
        this.vpulseCounter = 0;
        this.dispEnabled = FRAMESKIPENABLE;
        this.horizCounter = 0;
        this.vertCounter = 0;
        this.scanlineCounter = 0;
        this.vertAdjustCounter = 0;
        this.addr = 0;
        this.lineStartAddr = 0;
        this.nextLineStartAddr = 0;
        this.ulactrl = 0;
        this.pixelsPerChar = 8;
        this.halfClock = false;
        this.ulaMode = 0;
        this.teletextMode = false;
        this.displayEnableSkew = 0;
        this.ulaPal = utils.makeFast32(new Uint32Array(16));
        this.actualPal = new Uint8Array(16);
        this.teletext = new Teletext();
        this.cursorOn = false;
        this.cursorOff = false;
        this.cursorOnThisFrame = false;
        this.cursorDrawIndex = 0;
        this.cursorPos = 0;
        this.interlacedSyncAndVideo = false;
        this.doubledScanlines = true;
        this.frameSkipCount = 0;

        this.topBorder = 12;
        this.bottomBorder = 13;
        this.leftBorder = 5 * 16;
        this.rightBorder = 3 * 16;

        this.paint_ext = paint_ext_param;

        this.reset = function (cpu, via, hard) {
            this.cpu = cpu;
            this.sysvia = via;
            if (via) via.cb2changecallback = this.cb2changed.bind(this);
        };

        this.paint = function () {
            this.paint_ext(
                this.leftBorder,
                this.topBorder,
                1024 - this.rightBorder,
                625 - this.bottomBorder
            );
        };

        this.clearPaintBuffer = function() {
            var fb32 = this.fb32;
            if (this.interlacedSyncAndVideo || !this.doubledScanlines) {
                var line = (this.frameCount & 1);
                while (line < 625) {
                    var start = line * 1024;
                    fb32.fill(0, start, start + 1024);
                    line += 2;
                }
            } else {
                fb32.fill(0);
            }
        };

        this.paintAndClear = function() {
            if (this.dispEnabled & FRAMESKIPENABLE) {
                this.paint();
                this.clearPaintBuffer();
            }
            this.dispEnabled &= ~FRAMESKIPENABLE;
            var enable = FRAMESKIPENABLE;
            if (this.frameSkipCount > 1) {
                if (this.frameCount % this.frameSkipCount) enable = 0;
            }
            this.dispEnabled |= enable;

            this.bitmapY = 0;
            // Interlace even frame fires vsync midway through a scanline.
            if (!!(this.regs[8] & 1) && !!(this.frameCount & 1)) {
                this.bitmapY = -1;
            }
        };

        function copyFb(dest, src) {
            for (var i = 0; i < 1024 * 768; ++i) {
                dest[i] = src[i];
            }
        }

        var debugPrevScreen = null;

        this.debugOffset = function (x, y) {
            if (x < 0 || x >= 1024) return -1;
            if (y < 0 || y >= 768) return -1;
            var renderY = (y << 1);
            if (this.interlacedSyncAndVideo || !this.doubledScanlines) {
                this.renderY += (this.frameCount & 1);
            }
            return renderY * 1024 + x;
        };

        function lerp1(a, b, alpha) {
            var val = (b - a) * alpha + a;
            if (val < 0) val = 0;
            if (val > 255) val = 255;
            return val;
        }

        function lerp(col1, col2, alpha) {
            if (alpha < 0) alpha = 0;
            if (alpha > 1) alpha = 1;
            var r1 = (col1 >>> 16) & 0xff;
            var g1 = (col1 >>> 8) & 0xff;
            var b1 = (col1 >>> 0) & 0xff;
            var r2 = (col2 >>> 16) & 0xff;
            var g2 = (col2 >>> 8) & 0xff;
            var b2 = (col2 >>> 0) & 0xff;
            var red = lerp1(r1, r2, alpha);
            var green = lerp1(g1, g2, alpha);
            var blue = lerp1(b1, b2, alpha);
            return (red << 16) | (green << 8) | blue;
        }

        this.debugPaint = function () {
            if (!debugPrevScreen) {
                debugPrevScreen = new Uint32Array(1024 * 768);
            }
            copyFb(debugPrevScreen, this.fb32);
            var dotSize = 10;
            var x, y;
            for (y = -dotSize; y <= dotSize; y++) {
                for (x = -dotSize; x <= dotSize; ++x) {
                    var dist = Math.sqrt(x * x + y * y) / dotSize;
                    if (dist > 1) continue;
                    var offset = this.debugOffset(this.bitmapX + x, this.bitmapY + y);
                    this.fb32[offset] = lerp(this.fb32[offset], 0xffffff, Math.pow(1 - dist, 2));
                }
            }
            this.paint();
            copyFb(this.fb32, debugPrevScreen);
        };

        function table4bppOffset(ulamode, byte) {
            return (ulamode << 12) | (byte << 4);
        }

        this.table4bpp = function () {
            var t = new Uint8Array(4 * 256 * 16);
            var i, b, temp, left;
            for (b = 0; b < 256; ++b) {
                temp = b;
                for (i = 0; i < 16; ++i) {
                    left = 0;
                    if (temp & 2) left |= 1;
                    if (temp & 8) left |= 2;
                    if (temp & 32) left |= 4;
                    if (temp & 128) left |= 8;
                    t[table4bppOffset(3, b) + i] = left;
                    temp <<= 1;
                    temp |= 1;
                }
                for (i = 0; i < 16; ++i) {
                    t[table4bppOffset(2, b) + i] = t[table4bppOffset(3, b) + (i >>> 1)];
                    t[table4bppOffset(1, b) + i] = t[table4bppOffset(3, b) + (i >>> 2)];
                    t[table4bppOffset(0, b) + i] = t[table4bppOffset(3, b) + (i >>> 3)];
                }
            }
            return t;
        }();

        this.blitFb = function (dat, destOffset, numPixels, doubledY) {
            destOffset |= 0;
            numPixels |= 0;
            var offset = table4bppOffset(this.ulaMode, dat);
            var fb32 = this.fb32;
            var ulaPal = this.ulaPal;
            var table4bpp = this.table4bpp;
            var i = 0;
            if (doubledY) {
                for (i = 0; i < numPixels; ++i) {
                    fb32[destOffset + i] = fb32[destOffset + i + 1024] = ulaPal[table4bpp[offset + i]];
                }
            } else {
                for (i = 0; i < numPixels; ++i) {
                    fb32[destOffset + i] = ulaPal[table4bpp[offset + i]];
                }
            }
        };

        this.handleCursor = function (offset) {
            if (this.cursorOnThisFrame && (this.ulactrl & this.cursorTable[this.cursorDrawIndex])) {
                var i;
                for (i = 0; i < this.pixelsPerChar; ++i) {
                    this.fb32[offset + i] ^= 0x00ffffff;
                }
                if (this.doubledScanlines && !this.interlacedSyncAndVideo) {
                    for (i = 0; i < this.pixelsPerChar; ++i) {
                        this.fb32[offset + 1024 + i] ^= 0x00ffffff;
                    }
                }
            }
            if (++this.cursorDrawIndex === 7) this.cursorDrawIndex = 0;
        };

        this.screenAdd = 0;
        this.setScreenAdd = function (viaScreenAdd) {
            this.screenAdd = this.screenAddrAdd[viaScreenAdd];
        };

        this.readVideoMem = function () {
            if (this.addr & 0x2000) {
                // Mode 7 chunky addressing mode if MA13 set.
                // Address offset by scanline is ignored.
                // On model B only, there's a quirk for reading 0x3c00.
                // See: http://www.retrosoftware.co.uk/forum/viewtopic.php?f=73&t=1011
                var memAddr = this.addr & 0x3ff;
                if ((this.addr & 0x800) || this.isMaster) {
                    memAddr |= 0x7c00;
                } else {
                    memAddr |= 0x3c00;
                }
                return this.cpu.videoRead(memAddr);
            } else {
                var addr = (this.scanlineCounter & 0x07) | (this.addr << 3);
                // Perform screen address wrap around if MA12 set
                if (this.addr & 0x1000) addr += this.screenAdd;
                return this.cpu.videoRead(addr & 0x7fff);
            }
        };

        this.endOfFrame = function () {
            this.vertCounter = 0;
            this.firstScanline = true;
            this.nextLineStartAddr = (this.regs[13] | (this.regs[12] << 8)) & 0x3FFF;
            this.lineStartAddr = this.nextLineStartAddr;
            this.dispEnabled |= VDISPENABLE;
            var cursorFlash = (this.regs[10] & 0x60) >>> 5;
            this.cursorOnThisFrame = (cursorFlash === 0) || !!(this.frameCount & this.cursorFlashMask[cursorFlash]);
        };

        this.endOfCharacterLine = function () {
            this.vertCounter = (this.vertCounter + 1) & 0x7f;

            this.scanlineCounter = 0;
            this.hadVSyncThisRow = false;
            this.teletext.verticalCharEnd();
            this.dispEnabled |= SCANLINEDISPENABLE;
            this.cursorOn = false;
            this.cursorOff = false;
        };

        this.endOfScanline = function () {
            // End of scanline is the most complicated and quirky area of the
            // 6845. A lot of different states and outcomes are possible.
            // From the start of the frame, we traverse various states
            // linearly, with most optional:
            // - Normal rendering.
            // - Last scanline of normal rendering (vertical adjust pending).
            // - Vertical adjust.
            // - Last scanline of vertical adjust (dummy raster pending).
            // - Dummy raster. (This is for interlace timing.)
            this.firstScanline = false;

            if (this.scanlineCounter === this.regs[11]) this.cursorOff = true;

            this.vpulseCounter = (this.vpulseCounter + 1) & 0x0F;

            // Pre-counter increment compares and logic.
            var r9Hit = (this.scanlineCounter === this.regs[9]);
            if (r9Hit) {
                // An R9 hit always loads a new character row address, even if
                // we're in vertical adjust!
                // Note that an R9 hit inside vertical adjust does not further
                // increment the vertical counter, but entry into vertical
                // adjust does.
                this.lineStartAddr = this.nextLineStartAddr;
            }

            // Increment scanline.
            if (this.interlacedSyncAndVideo) {
                this.scanlineCounter = (this.scanlineCounter + 2) & 0x1e;
            } else {
                this.scanlineCounter = (this.scanlineCounter + 1) & 0x1f;
            }
            if (!this.teletextMode) {
                // Scanlines 8-15 are off but they display again at 16,
                // mirroring 0-7, and it repeats.
                var off = (this.scanlineCounter >>> 3) & 1;
                if (off) {
                    this.dispEnabled &= ~SCANLINEDISPENABLE;
                } else {
                    this.dispEnabled |= SCANLINEDISPENABLE;
                }
            }

            // Reset scanline if necessary.
            if (!this.inVertAdjust && r9Hit) {
                this.endOfCharacterLine();
            }

            if (this.endOfMainLatched && !this.endOfVertAdjustLatched) {
                this.inVertAdjust = true;
            }

            var endOfFrame = false;

            if (this.endOfFrameLatched) {
                endOfFrame = true;
            }

            if (this.endOfVertAdjustLatched) {
                this.inVertAdjust = false;
                // The "dummy raster" is inserted at the very end of frame,
                // after vertical adjust, for even interlace frames.
                // Testing indicates it is checked right here, a clock before
                // it is entered or not.
                // Like vertical adjust, C4=R4+1.
                if (!!(this.regs[8] & 1) && !!(this.frameCount & 1)) {
                    this.inDummyRaster = true;
                    this.endOfFrameLatched = true;
                } else {
                    endOfFrame = true;
                }
            }

            if (endOfFrame) {
                this.endOfMainLatched = false;
                this.endOfVertAdjustLatched = false;
                this.endOfFrameLatched = false;
                this.inDummyRaster = false;

                this.endOfCharacterLine();
                this.endOfFrame();
            }

            this.addr = this.lineStartAddr;
            this.teletext.endline();

            var cursorStartLine = this.regs[10] & 0x1f;
            if (this.scanlineCounter === cursorStartLine) this.cursorOn = true;
        };

        this.handleHSync = function () {
            this.hpulseCounter = (this.hpulseCounter + 1) & 0x0F;
            if (this.hpulseCounter === (this.hpulseWidth >>> 1)) {
                // Start at -8 because the +8 is added before the pixel render.
                this.bitmapX = -8;

                // Half-clock horizontal movement
                if (this.hpulseWidth & 1) {
                    this.bitmapX -= 4;
                }

                // The CRT vertical beam speed is constant, so this is actually
                // an approximation that works if hsyncs are spaced evenly.
                this.bitmapY += 2;

                // If no VSync occurs this frame, go back to the top and force a repaint
                if (this.bitmapY >= 768) {
                    // Arbitrary moment when TV will give up and start flyback in the absence of an explicit VSync signal
                    this.paintAndClear();
                }
            } else if (this.hpulseCounter === (this.regs[3] & 0x0F)) {
                this.inHSync = false;
            }
        };

        this.cb2changed = function (level, output) {
            // Even with no light pen physically attached, the system VIA can
            // configure CB2 as an output and make the CRTC think it sees a
            // real light pen pulse.
            // Triggers on the low -> high CB2 edge.
            // Needed by Pharaoh's Curse to start.
            if (level && output) {
                this.regs[16] = (this.addr >> 8) & 0x3f;
                this.regs[17] = this.addr & 0xff;
            }
        };

        ////////////////////
        // Main drawing routine
        this.polltime = function (clocks) {
            while (clocks--) {
                this.oddClock = !this.oddClock;
                // Advance CRT beam.
                this.bitmapX += 8;

                if (this.halfClock && !this.oddClock) {
                    continue;
                }

                // This emulates the Hitachi 6845SP CRTC.
                // Other variants have different quirks.

                // Handle HSync
                if (this.inHSync) this.handleHSync();

                // Handle delayed display enable due to skew
                var displayEnablePos = this.displayEnableSkew + (this.teletextMode ? 2 : 0);
                if (this.horizCounter === displayEnablePos) this.dispEnabled |= SKEWDISPENABLE;

                // Latch next line screen address in case we are in the last line of a character row
                if (this.horizCounter === this.regs[1]) this.nextLineStartAddr = this.addr;

                // Handle end of horizontal displayed.
                // Make sure to account for display enable skew.
                // Also, the last scanline character never displays.
                if ((this.horizCounter === this.regs[1] + displayEnablePos) || (this.horizCounter === this.regs[0] + displayEnablePos))
                    this.dispEnabled &= ~(HDISPENABLE | SKEWDISPENABLE);

                // Initiate HSync.
                if (this.horizCounter === this.regs[2] && !this.inHSync) {
                    this.inHSync = true;
                    this.hpulseCounter = 0;
                }

                // Handle VSync.
                // Half-line interlace timing is shown nicely in figure 13 here:
                // http://bitsavers.trailing-edge.com/components/motorola/_dataSheets/6845.pdf
                // Essentially, on even frames, vsync raise / lower triggers at
                // the mid-scanline, and then a dummy scanline is also added
                // at the end of vertical adjust.
                // Without interlace, frames are 312 scanlines. With interlace,
                // both odd and even frames are 312.5 scanlines.
                var isInterlace = !!(this.regs[8] & 1);
                var halfR0Hit = (this.horizCounter === this.regs[0] >>> 1);
                var evenFrame = !!(this.frameCount & 1);
                var isVsyncPoint = (!isInterlace || !evenFrame || halfR0Hit);
                var vSyncEnding = false;
                var vSyncStarting = false;
                if (this.inVSync &&
                    this.vpulseCounter === this.vpulseWidth &&
                    isVsyncPoint) {
                    vSyncEnding = true;
                    this.inVSync = false;
                }
                if (this.vertCounter === this.regs[7] &&
                    !this.inVSync &&
                    !this.hadVSyncThisRow &&
                    isVsyncPoint) {
                    vSyncStarting = true;
                    this.inVSync = true;
                }

                // A vsync will initiate at any character and scanline position,
                // provided there isn't one in progress and provided there
                // wasn't already one in this character row.
                // This is an interesting finding, on a real model B.
                // One further emulated quirk is that in the corner case of a
                // vsync ending and starting at the same time, the vsync
                // pulse continues uninterrupted. The vsync pulse counter will
                // continue counting up and wrap at 16.
                if (vSyncStarting && !vSyncEnding) {
                    this.hadVSyncThisRow = true;
                    this.vpulseCounter = 0;

                    // Avoid intense painting if registers have boot-up or
                    // otherwise small values.
                    if (this.regs[0] && this.regs[4]) {
                        this.paintAndClear();
                    }
                    this.teletext.vsync();
                }

                if (vSyncStarting || vSyncEnding) {
                    this.sysvia.setVBlankInt(this.inVSync);
                }

                // TODO: this will be cleaner if we rework skew to have fetch
                // independent from render.
                var insideBorder = (this.dispEnabled & (HDISPENABLE | VDISPENABLE)) === (HDISPENABLE | VDISPENABLE);
                if ((insideBorder || this.cursorDrawIndex) && (this.dispEnabled & FRAMESKIPENABLE)) {
                    // Read data from address pointer if both horizontal and vertical display enabled.
                    var dat = this.readVideoMem();
                    if (insideBorder) {
                        if (this.teletextMode) {
                            this.teletext.fetchData(dat);
                        }

                        // Check cursor start.
                        if (this.addr === this.cursorPos && this.cursorOn && !this.cursorOff && this.horizCounter < this.regs[1]) {
                            this.cursorDrawIndex = 3 - ((this.regs[8] >>> 6) & 3);
                        }

                    }

                    // Render data depending on display enable state.
                    if (this.bitmapX >= 0 && this.bitmapX < 1024 && this.bitmapY < 625) {
                        var doubledLines = false;
                        var offset = this.bitmapY;
                        if (this.doubledScanlines &&
                            !this.interlacedSyncAndVideo) {
                            doubledLines = true;
                            offset &= ~1;
                        }

                        offset = (offset * 1024) + this.bitmapX;

                        if ((this.dispEnabled & EVERYTHINGENABLED) === EVERYTHINGENABLED) {
                            if (this.teletextMode) {
                                this.teletext.render(this.fb32, offset, this.scanlineCounter + (this.frameCount & 1));
                            } else {
                                this.blitFb(dat, offset, this.pixelsPerChar, doubledLines);
                            }
                        }
                        if (this.cursorDrawIndex) {
                            this.handleCursor(offset, doubledLines);
                        }
                    }
                }

                // CRTC MA always increments, inside display border or not.
                this.addr = (this.addr + 1) & 0x3fff;

                // The Hitachi 6845 decides to end (or never enter) vertical
                // adjust here, one clock after checking whether to enter
                // vertical adjust.
                // In a normal frame, this is C0=2.
                if (this.checkVertAdjust) {
                    this.checkVertAdjust = false;
                    if (this.endOfMainLatched) {
                        if (this.vertAdjustCounter === this.regs[5]) {
                            this.endOfVertAdjustLatched = true;
                        }
                        this.vertAdjustCounter++;
                        this.vertAdjustCounter &= 0x1f;
                    }
                }

                // The Hitachi 6845 appears to latch some form of "last scanline
                // of the frame" state. As shown by Twisted Brain, changing R9
                // from 0 to 6 on the last scanline of the frame does not
                // prevent a new frame from starting.
                // Testing indicates that the latch is set here at exactly C0=1.
                // See also: http://www.cpcwiki.eu/forum/programming/crtc-detailed-operation/msg177585/
                if (this.horizCounter === 1) {
                    if (this.vertCounter === this.regs[4] &&
                        this.scanlineCounter === this.regs[9]) {
                        this.endOfMainLatched = true;
                        this.vertAdjustCounter = 0;
                    }
                    // The very next cycle (be it on this same scanline or the
                    // next) is used for checking the vertical adjust counter.
                    this.checkVertAdjust = true;
                }

                // Handle horizontal total.
                if (this.horizCounter === this.regs[0]) {
                    this.endOfScanline();
                    this.horizCounter = 0;
                    this.dispEnabled |= HDISPENABLE;
                } else {
                    this.horizCounter = (this.horizCounter + 1) & 0xff;
                }

                // Handle end of vertical displayed.
                // The Hitachi 6845 will notice this equality at any character,
                // including in the middle of a scanline.
                // An exception is the very first scanline of a frame, where
                // vertical display is always on.
                // We do this after the render and various counter increments
                // because there seems to be a 1 character delay between setting
                // R6=C4 and display actually stopping.
                var r6Hit = (this.vertCounter === this.regs[6]);
                if (r6Hit &&
                    !this.firstScanline &&
                    (this.dispEnabled & VDISPENABLE)) {
                    this.dispEnabled &= ~VDISPENABLE;
                    // Perhaps surprisingly, this happens here. Both cursor
                    // blink and interlace cease if R6 > R4.
                    this.frameCount++;
                }

            } // matches while
        };
        ////////////////////

        ////////////////////
        // CRTC interface
        function Crtc(video) {
            this.video = video;
            this.curReg = 0;
            this.crtcmask = new Uint8Array([
                0xff, 0xff, 0xff, 0xff, 0x7f, 0x1f, 0x7f, 0x7f,
                0xf3, 0x1f, 0x7f, 0x1f, 0x3f, 0xff, 0x3f, 0xff,
                0x3f, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        }

        Crtc.prototype.read = function (addr) {
            if (!(addr & 1))
                return 0;
            switch (this.curReg) {
                case 12:
                case 13:
                case 14:
                case 15:
                case 16:
                case 17:
                    return this.video.regs[this.curReg];
            }
            return 0;
        };
        Crtc.prototype.write = function (addr, val) {
            if (addr & 1) {
                this.video.regs[this.curReg] = val & this.crtcmask[this.curReg];
                switch (this.curReg) {
                    case 3:
                        this.video.hpulseWidth = val & 0x0F;
                        this.video.vpulseWidth = (val & 0xF0) >>> 4;
                        break;
                    case 8:
                        this.video.interlacedSyncAndVideo = (val & 3) === 3;
                        var skew = (val & 0x30) >>> 4;
                        if (skew < 3) {
                            this.video.displayEnableSkew = skew;
                            this.video.dispEnabled |= USERDISPENABLE;
                        } else {
                            this.video.dispEnabled &= ~USERDISPENABLE;
                        }
                        break;
                    case 14:
                    case 15:
                        this.video.cursorPos = (this.video.regs[15] | (this.video.regs[14] << 8)) & 0x3fff;
                        break;
                }
            } else
                this.curReg = val & 31;
        };
        this.crtc = new Crtc(this);

        ////////////////////
        // ULA interface
        function Ula(video) {
            this.video = video;
        }

        Ula.prototype.write = function (addr, val) {
            addr |= 0;
            val |= 0;
            var index;
            if (addr & 1) {
                index = (val >>> 4) & 0xf;
                this.video.actualPal[index] = val & 0xf;
                var ulaCol = val & 7;
                if (!((val & 8) && (this.video.ulactrl & 1)))
                    ulaCol ^= 7;
                if (this.video.ulaPal[index] !== this.video.collook[ulaCol]) {
                    this.video.ulaPal[index] = this.video.collook[ulaCol];
                }
            } else {
                if ((this.video.ulactrl ^ val) & 1) {
                    // Flash colour has changed.
                    var flashEnabled = !!(val & 1);
                    for (var i = 0; i < 16; ++i) {
                        index = this.video.actualPal[i] & 7;
                        if (!(flashEnabled && (this.video.actualPal[i] & 8))) index ^= 7;
                        if (this.video.ulaPal[i] !== this.video.collook[index]) {
                            this.video.ulaPal[i] = this.video.collook[index];
                        }
                    }
                }
                this.video.ulactrl = val;
                this.video.pixelsPerChar = (val & 0x10) ? 8 : 16;
                this.video.halfClock = !(val & 0x10);
                var newMode = (val >>> 2) & 3;
                if (newMode !== this.video.ulaMode) {
                    this.video.ulaMode = newMode;
                }
                this.video.teletextMode = !!(val & 2);
            }
        };

        this.ula = new Ula(this);

        this.reset(null);

        this.clearPaintBuffer();
        this.paint();
    }

    function FakeVideo() {
        this.reset = function () {
        };
        this.ula = this.crtc = {
            read: function () {
                return 0xff;
            },
            write: utils.noop
        };
        this.polltime = utils.noop;
        this.setScreenAdd = utils.noop;
        this.regs = new Uint8Array(32);
    }

    return {
        Video: Video,
        FakeVideo: FakeVideo
    };
});
